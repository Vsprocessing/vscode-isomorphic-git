import type { GitHttpRequest, GitHttpResponse, HttpClient } from "isomorphic-git";
import { libcurl } from "libcurl.js/bundled";
import * as vscode from "vscode";

export const http: HttpClient = {
  request,
};

let configuredWispUrl: string | undefined;

export async function request({
  url,
  method = "GET",
  headers = {},
  body,
  signal,
}: GitHttpRequest): Promise<GitHttpResponse> {
  await configureLibcurl();

  const requestBody = body ? new Blob([toArrayBuffer(await collect(body))]) : undefined;
  const response = await libcurl.fetch(url, {
    method,
    headers,
    body: requestBody,
    signal: signal as AbortSignal | undefined,
  });

  return {
    url: response.url,
    method,
    statusCode: response.status,
    statusMessage: response.statusText,
    headers: responseHeaders(response),
    body: response.body
      ? streamToAsyncIterable(response.body)
      : fromValue(new Uint8Array(await response.arrayBuffer())),
  };
}

export async function proxiedFetch(
  url: string,
  init: { method: string; headers: Record<string, string>; body: string }
): Promise<Response> {
  await configureLibcurl();
  return libcurl.fetch(url, init);
}

async function configureLibcurl(): Promise<void> {
  const configuredUrl = vscode.workspace
    .getConfiguration("isomorphic-git")
    .get<string>("libcurlWispUrl");
  const wispUrl = configuredUrl && normalizeWispUrl(configuredUrl);
  if (!wispUrl) {
    throw new Error("Set isomorphic-git.libcurlWispUrl before using Git over HTTP.");
  }

  if (libcurl.load_wasm) {
    await libcurl.load_wasm();
  }
  if (configuredWispUrl !== wispUrl) {
    libcurl.set_websocket(wispUrl);
    configuredWispUrl = wispUrl;
  }
}

function normalizeWispUrl(url: string): string {
  if (url.startsWith("https://")) {
    return "wss://" + url.slice("https://".length);
  }
  if (url.startsWith("http://")) {
    return "ws://" + url.slice("http://".length);
  }
  return url;
}

async function collect(
  iterable: AsyncIterable<Uint8Array>
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of iterable) {
    chunks.push(chunk);
    size += chunk.byteLength;
  }

  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function responseHeaders(response: Response): Record<string, string> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  return headers;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

function streamToAsyncIterable(
  stream: ReadableStream<Uint8Array>
): AsyncIterableIterator<Uint8Array> {
  const reader = stream.getReader();
  return {
    async next() {
      return reader.read();
    },
    async return() {
      reader.releaseLock();
      return { done: true, value: undefined };
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  };
}

function fromValue(value: Uint8Array): AsyncIterableIterator<Uint8Array> {
  let done = false;
  return {
    async next() {
      if (done) {
        return { done: true, value: undefined };
      }
      done = true;
      return { done: false, value };
    },
    async return() {
      done = true;
      return { done: true, value: undefined };
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  };
}
