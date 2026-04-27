import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import worker, { statsFromStorageRow } from '../workers.js';

const originalFetch = globalThis.fetch;
const originalConsoleError = console.error;

afterEach(() => {
  globalThis.fetch = originalFetch;
  console.error = originalConsoleError;
});

test('POST proxy forwards the request body without reading it into an ArrayBuffer first', async () => {
  const payload = 'streamed request payload';
  const waitUntilPromises = [];
  let upstreamRequest;

  globalThis.fetch = async (request) => {
    upstreamRequest = request;
    return new Response(await request.text(), { status: 201 });
  };

  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(payload));
      controller.close();
    }
  });

  const request = {
    url: 'https://proxy.example/upload',
    method: 'POST',
    headers: new Headers({ 'Content-Type': 'text/plain' }),
    body,
    clone() {
      return {
        async arrayBuffer() {
          throw new Error('proxy should stream request.body instead of buffering');
        }
      };
    }
  };

  const response = await worker.fetch(request, {}, {
    waitUntil(promise) {
      waitUntilPromises.push(promise);
    }
  });

  assert.equal(response.status, 201);
  assert.equal(await response.text(), payload);
  assert.ok(upstreamRequest instanceof Request);
  assert.equal(upstreamRequest.method, 'POST');
  assert.equal(upstreamRequest.url, 'https://free.lilyemby.com/upload');

  await Promise.all(waitUntilPromises);
});

test('proxy gets a fresh Durable Object stub for each request', async () => {
  const waitUntilPromises = [];
  const stubContexts = [];
  let activeRequestContext = 0;
  const errors = [];

  console.error = (...args) => {
    errors.push(args.join(' '));
  };

  globalThis.fetch = async () => new Response('ok');

  const env = {
    STATS_DO: {
      idFromName(name) {
        return name;
      },
      get() {
        const createdInContext = activeRequestContext;
        return {
          async fetch() {
            stubContexts.push(createdInContext);
            if (createdInContext !== activeRequestContext) {
              throw new Error('stub reused across request contexts');
            }
            return new Response('{}');
          }
        };
      }
    }
  };

  for (const context of [1, 2]) {
    activeRequestContext = context;
    const response = await worker.fetch(new Request(`https://proxy.example/request-${context}`), env, {
      waitUntil(promise) {
        waitUntilPromises.push(promise);
      }
    });

    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'ok');
  }

  await Promise.all(waitUntilPromises);

  assert.deepEqual(stubContexts, [1, 2]);
  assert.deepEqual(errors, []);
});

test('Range media responses are passed through without wrapping the upstream stream', async () => {
  const waitUntilPromises = [];
  const statPayloads = [];
  let upstreamBody;

  globalThis.fetch = async () => {
    upstreamBody = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3, 4]));
        controller.close();
      }
    });

    return new Response(upstreamBody, {
      status: 206,
      headers: {
        'Content-Type': 'video/x-matroska',
        'Content-Length': '4',
        'Content-Range': 'bytes 0-3/100',
        'Accept-Ranges': 'bytes'
      }
    });
  };

  const env = {
    STATS_DO: {
      idFromName(name) {
        return name;
      },
      get() {
        return {
          async fetch(_url, init) {
            statPayloads.push(JSON.parse(init.body));
            return new Response('{}');
          }
        };
      }
    }
  };

  const response = await worker.fetch(new Request('https://proxy.example/emby/videos/1/original.mkv', {
    headers: { Range: 'bytes=0-' }
  }), env, {
    waitUntil(promise) {
      waitUntilPromises.push(promise);
    }
  });

  assert.equal(response.status, 206);
  assert.equal(response.headers.get('Content-Range'), 'bytes 0-3/100');
  assert.equal(response.body, upstreamBody);
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), new Uint8Array([1, 2, 3, 4]));

  await Promise.all(waitUntilPromises);

  assert.equal(statPayloads.length, 1);
  assert.equal(statPayloads[0].bytes, 4);
  assert.equal(statPayloads[0].meta.hasRange, true);
  assert.equal(statPayloads[0].meta.isPartialContent, true);
  assert.equal(statPayloads[0].meta.isMedia, true);
  assert.equal(statPayloads[0].meta.isUnmeteredPassthrough, false);
  assert.equal(statPayloads[0].meta.unmeteredBytesHint, 0);
});

test('bounded Range media passthrough counts only the returned range bytes', async () => {
  const waitUntilPromises = [];
  const statPayloads = [];

  globalThis.fetch = async () => new Response(new Uint8Array([1, 2, 3, 4]), {
    status: 206,
    headers: {
      'Content-Type': 'video/x-matroska',
      'Content-Length': '4',
      'Content-Range': 'bytes 0-3/100',
      'Accept-Ranges': 'bytes'
    }
  });

  const env = {
    STATS_DO: {
      idFromName(name) {
        return name;
      },
      get() {
        return {
          async fetch(_url, init) {
            statPayloads.push(JSON.parse(init.body));
            return new Response('{}');
          }
        };
      }
    }
  };

  const response = await worker.fetch(new Request('https://proxy.example/emby/videos/1/original.mkv', {
    headers: { Range: 'bytes=0-3' }
  }), env, {
    waitUntil(promise) {
      waitUntilPromises.push(promise);
    }
  });

  assert.equal(response.status, 206);
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), new Uint8Array([1, 2, 3, 4]));

  await Promise.all(waitUntilPromises);

  assert.equal(statPayloads.length, 1);
  assert.equal(statPayloads[0].bytes, 4);
  assert.equal(statPayloads[0].meta.isUnmeteredPassthrough, false);
  assert.equal(statPayloads[0].meta.unmeteredBytesHint, 0);
});

test('small open-ended Range media passthrough counts the returned tail bytes', async () => {
  const waitUntilPromises = [];
  const statPayloads = [];

  globalThis.fetch = async () => new Response(new Uint8Array(11155), {
    status: 206,
    headers: {
      'Content-Type': 'video/x-matroska',
      'Content-Length': '11155',
      'Content-Range': 'bytes 1294949191-1294960345/1294960346',
      'Accept-Ranges': 'bytes'
    }
  });

  const env = {
    STATS_DO: {
      idFromName(name) {
        return name;
      },
      get() {
        return {
          async fetch(_url, init) {
            statPayloads.push(JSON.parse(init.body));
            return new Response('{}');
          }
        };
      }
    }
  };

  const response = await worker.fetch(new Request('https://proxy.example/emby/videos/1/original.mkv', {
    headers: { Range: 'bytes=1294949191-' }
  }), env, {
    waitUntil(promise) {
      waitUntilPromises.push(promise);
    }
  });

  assert.equal(response.status, 206);
  await response.arrayBuffer();
  await Promise.all(waitUntilPromises);

  assert.equal(statPayloads.length, 1);
  assert.equal(statPayloads[0].bytes, 11155);
  assert.equal(statPayloads[0].meta.isUnmeteredPassthrough, false);
  assert.equal(statPayloads[0].meta.unmeteredBytesHint, 0);
});

test('large open-ended Range media passthrough remains unmetered to avoid full-file overcounting', async () => {
  const waitUntilPromises = [];
  const statPayloads = [];

  globalThis.fetch = async () => new Response(new Uint8Array([1, 2, 3, 4]), {
    status: 206,
    headers: {
      'Content-Type': 'video/x-matroska',
      'Content-Length': '1294960346',
      'Content-Range': 'bytes 0-1294960345/1294960346',
      'Accept-Ranges': 'bytes'
    }
  });

  const env = {
    STATS_DO: {
      idFromName(name) {
        return name;
      },
      get() {
        return {
          async fetch(_url, init) {
            statPayloads.push(JSON.parse(init.body));
            return new Response('{}');
          }
        };
      }
    }
  };

  const response = await worker.fetch(new Request('https://proxy.example/emby/videos/1/original.mkv', {
    headers: { Range: 'bytes=0-' }
  }), env, {
    waitUntil(promise) {
      waitUntilPromises.push(promise);
    }
  });

  assert.equal(response.status, 206);
  await response.arrayBuffer();
  await Promise.all(waitUntilPromises);

  assert.equal(statPayloads.length, 1);
  assert.equal(statPayloads[0].bytes, 0);
  assert.equal(statPayloads[0].meta.isUnmeteredPassthrough, true);
  assert.equal(statPayloads[0].meta.unmeteredBytesHint, 1294960346);
});

test('stored stats rows derive top-level extended metrics from port details', () => {
  const stats = statsFromStorageRow({
    total: 3,
    success: 2,
    error: 1,
    bytes: 3000,
    duration: 900,
    ports: JSON.stringify({
      '443': {
        total: 2,
        success: 2,
        error: 0,
        bytes: 2400,
        duration: 600,
        statusCodes: { 206: 2 },
        rangeRequests: 2,
        partialContentResponses: 2,
        mediaRequests: 2,
        mediaBytes: 2400,
        apiBytes: 0,
        maxRequestBytes: 1400,
        unmeteredMediaRequests: 1,
        unmeteredMediaBytesHint: 5000
      },
      '8443': {
        total: 1,
        success: 0,
        error: 1,
        bytes: 600,
        duration: 300,
        statusCodes: { 502: 1 },
        rangeRequests: 0,
        partialContentResponses: 0,
        mediaRequests: 0,
        mediaBytes: 0,
        apiBytes: 600,
        maxRequestBytes: 600
      }
    })
  });

  assert.equal(stats.total, 3);
  assert.equal(stats.bytes, 3000);
  assert.deepEqual(stats.statusCodes, { 206: 2, 502: 1 });
  assert.equal(stats.rangeRequests, 2);
  assert.equal(stats.partialContentResponses, 2);
  assert.equal(stats.mediaRequests, 2);
  assert.equal(stats.mediaBytes, 2400);
  assert.equal(stats.apiBytes, 600);
  assert.equal(stats.maxRequestBytes, 1400);
  assert.equal(stats.unmeteredMediaRequests, 1);
  assert.equal(stats.unmeteredMediaBytesHint, 5000);
});
