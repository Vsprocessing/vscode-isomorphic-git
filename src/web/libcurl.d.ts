declare module "libcurl.js/bundled" {
  export const libcurl: {
    ready?: boolean;
    load_wasm?: () => Promise<void>;
    set_websocket(url: string): void;
    fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  };
}
