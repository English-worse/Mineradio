'use strict';

const assert = require('assert');
const http = require('http');
const https = require('https');
const { EventEmitter } = require('events');
const kugou = require('../kugou-api');

function requireTestFunction(runtime, name) {
  const fn = runtime && runtime._test && runtime._test[name];
  assert.strictEqual(typeof fn, 'function', `Kugou must expose _test.${name}`);
  return fn;
}

function withKugouNetworkMock(handler, task) {
  const originalHttp = http.request;
  const originalHttps = https.request;
  function mockRequest(lib, targetUrl, options, callback) {
    const request = new EventEmitter();
    const chunks = [];
    request.write = chunk => chunks.push(Buffer.from(String(chunk)));
    request.setTimeout = () => request;
    request.destroy = error => process.nextTick(() => request.emit('error', error || new Error('destroyed')));
    request.end = () => {
      Promise.resolve(handler({
        url: String(targetUrl),
        options: options || {},
        body: Buffer.concat(chunks).toString('utf8'),
      })).then(result => {
        result = result || {};
        const response = new EventEmitter();
        response.statusCode = Number(result.statusCode || 200);
        response.headers = result.headers || {};
        callback(response);
        process.nextTick(() => {
          const body = typeof result.body === 'string' ? result.body : JSON.stringify(result.body || {});
          response.emit('data', Buffer.from(body));
          response.emit('end');
        });
      }).catch(error => request.emit('error', error));
    };
    return request;
  }
  http.request = function (targetUrl, options, callback) {
    return mockRequest(http, targetUrl, options, callback);
  };
  https.request = function (targetUrl, options, callback) {
    return mockRequest(https, targetUrl, options, callback);
  };
  return Promise.resolve().then(task).finally(() => {
    http.request = originalHttp;
    https.request = originalHttps;
  });
}

function testPickQualityHashMatch() {
  const pick = requireTestFunction(kugou, 'pickKugouQualityHashMatch');
  const song = {
    name: '晴天',
    artist: '周杰伦',
    duration: 259000,
    hash: 'BASE_HASH',
    albumAudioId: '32100650',
    albumId: '966846',
  };

  const exactByHash = pick(song, [
    { name: '晴天', artist: '周杰伦', duration: 259000, hash: 'BASE_HASH', sqHash: 'SQ_EXACT' },
  ]);
  assert.strictEqual(exactByHash.sqHash, 'SQ_EXACT', 'same base hash must win immediately');

  const exactByAudioId = pick(song, [
    { name: '晴天', artist: '周杰伦', duration: 259000, hash: 'OTHER_HASH', albumAudioId: '32100650', sqHash: 'SQ_AUDIO' },
  ]);
  assert.strictEqual(exactByAudioId.sqHash, 'SQ_AUDIO', 'same album audio id must win immediately');

  const closeDuration = pick(song, [
    { name: '晴天', artist: '周杰伦', duration: 260000, hash: 'OTHER_HASH', sqHash: 'SQ_CLOSE' },
  ]);
  assert.strictEqual(closeDuration.sqHash, 'SQ_CLOSE', 'same title/artist with close duration must be accepted');

  const farDuration = pick(song, [
    { name: '晴天', artist: '周杰伦', duration: 264000, hash: 'OTHER_HASH', sqHash: 'SQ_FAR' },
  ]);
  assert.strictEqual(farDuration, null, 'same title but far duration must not be used');

  const wrongArtist = pick(song, [
    { name: '晴天', artist: '周杰伦', duration: 259000, hash: 'OTHER_HASH', sqHash: 'SQ_ARTIST' },
  ].map(item => Object.assign({}, item, { artist: '其他歌手' })));
  assert.strictEqual(wrongArtist, null, 'same title with different artist must not be used');

  const noQualityHash = pick(song, [
    { name: '晴天', artist: '周杰伦', duration: 259000, hash: 'OTHER_HASH' },
  ]);
  assert.strictEqual(noQualityHash, null, 'a match without any quality hash must not be used');

  const unknownDuration = pick({ name: '晴天', artist: '周杰伦', duration: 0 }, [
    { name: '晴天', artist: '周杰伦', duration: 259000, sqHash: 'SQ_UNKNOWN' },
  ]);
  assert.strictEqual(unknownDuration.sqHash, 'SQ_UNKNOWN', 'unknown duration may use a title/artist match');

  const noName = pick({ artist: '周杰伦', duration: 259000 }, [
    { name: '晴天', artist: '周杰伦', duration: 259000, sqHash: 'SQ_NONAME' },
  ]);
  assert.strictEqual(noName, null, 'missing song name must never guess');
}

async function testEnrichmentDrivesLosslessPlayback() {
  const enrich = requireTestFunction(kugou, 'kugouEnrichQualityHashes');
  const cookie = 'userid=71009; token=enrich-fixture-token; kg_mid=enrich-fixture-mid';
  let searchRequests = 0;
  let urlQuality = '';

  await withKugouNetworkMock(({ url }) => {
    const parsed = new URL(url);
    if (parsed.hostname === 'songsearch.kugou.com' && parsed.pathname === '/song_search_v2') {
      searchRequests += 1;
      return {
        body: {
          data: {
            lists: [{
              FileHash: 'BASE_HASH',
              SongName: '晴天',
              SingerName: '周杰伦',
              Duration: 259,
              AlbumID: '966846',
              AlbumAudioID: '32100650',
              SQFileHash: 'LOSSESS_HASH',
              HQFileHash: 'HIGH_HASH',
              ResFileHash: 'RES_HASH',
            }],
          },
        },
      };
    }
    if (parsed.pathname === '/v1/get_union_vip') {
      return { body: { status: 1, data: { userid: '71009', is_vip: true, vip_type: 1 } } };
    }
    if (parsed.pathname === '/v5/url') {
      urlQuality = parsed.searchParams.get('quality') || '';
      return { body: { status: 1, url: 'https://media.example/kugou-lossless.flac' } };
    }
    throw new Error('Unexpected enrichment request: ' + parsed.hostname + parsed.pathname);
  }, async () => {
    const result = await kugou.handleKugouSongUrl({
      hash: 'BASE_HASH',
      name: '晴天',
      artist: '周杰伦',
      duration: 259000,
      albumId: '966846',
      albumAudioId: '32100650',
      quality: 'lossless',
    }, cookie);
    assert.strictEqual(result.playable, true, 'enriched playlist track must become playable');
    assert.strictEqual(result.level, 'lossless', 'enriched playlist track must resolve to lossless');
    assert.strictEqual(result.url, 'https://media.example/kugou-lossless.flac', 'lossless URL must be returned');
  });

  assert.strictEqual(searchRequests, 1, 'missing quality hash must trigger exactly one search');
  assert.strictEqual(urlQuality, 'flac', 'lossless playback must request flac from Kugou');

  let extraSearch = 0;
  await withKugouNetworkMock(({ url }) => {
    const parsed = new URL(url);
    if (parsed.hostname === 'songsearch.kugou.com') {
      extraSearch += 1;
      throw new Error('explicit sqHash must not trigger another search');
    }
    return { body: { status: 1, data: {} } };
  }, async () => {
    const enriched = await enrich({
      hash: 'HAS_SQ',
      name: '晴天',
      artist: '周杰伦',
      sqHash: 'SQ_ALREADY',
    }, cookie, { playbackReady: true });
    assert.strictEqual(enriched.sqHash, 'SQ_ALREADY', 'explicit sqHash must be preserved');
  });
  assert.strictEqual(extraSearch, 0, 'explicit sqHash must skip enrichment search');
}

async function main() {
  testPickQualityHashMatch();
  await testEnrichmentDrivesLosslessPlayback();
  console.log('[OK] Kugou playlist quality-hash enrichment resolves lossless without unsafe guesses.');
}

main().catch(error => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
