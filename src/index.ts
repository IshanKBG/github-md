import { createElement } from "react";
import { renderToString } from "react-dom/server";

import emoji from "node-emoji";
import frontmatter from "front-matter";
import hljs from "highlight.js";
import { marked } from "marked";
import sanitize from "sanitize-html";

import Demo from "./demo";

let REVALIDATE_AFTER_MS = 5 * 60 * 1000;
let STALE_FOR_SECONDS = 2 * 24 * 60 * 60;

declare global {
  interface CacheStorage {
    default: Cache;
  }
}

type Env = {};

type ApiData = {
  attributes: unknown;
  html: string;
};

type ApiError = {
  error: string;
};

type ApiResponse = ApiData | ApiError;

type Cached = ApiData;

type CachedFile = {
  path: string;
  sha: string;
};

type CachedFiles = {
  sha: string;
  files: CachedFile[];
};

export default {
  fetch: handleFetch,
};

async function handleFetch(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  try {
    let url = new URL(request.url);

    let response = shouldSkipCache(request)
      ? null
      : await caches.default.match(request.url);

    if (response) {
      return response;
    }

    if (url.pathname === "/") {
      response = await renderDocs(request, ctx);
    } else if (url.pathname.startsWith("/_demo/")) {
      response = await renderDemo(request, ctx);
    } else if (url.pathname.split("/").filter((s) => s !== "").length === 3) {
      response = await renderFiles(request, ctx);
    } else {
      response = await renderMarkdown(request, ctx);
    }

    ctx.waitUntil(caches.default.put(request.url, response.clone()));

    return response;
  } catch (error) {
    console.log(error);

    return new Response(JSON.stringify({ error: "Internal server error" }), {
      status: 500,
      headers: {
        "Content-Type": "application/json",
      },
    });
  }
}

async function renderDocs(
  request: Request,
  ctx: ExecutionContext
): Promise<Response> {
  let url = new URL(request.url);
  let domain = new URL("/", url).href;

  let markdownHeaders = new Headers();
  request.headers.has("Cache-Control") &&
    markdownHeaders.append(
      "Cache-Control",
      request.headers.get("Cache-Control")!
    );

  let markdownResponse = await renderMarkdown(
    new Request(new URL("/jacob-ebey/github-md/main/README.md", domain).href, {
      headers: markdownHeaders,
    }),
    ctx
  );
  let markdownJson = (await markdownResponse.json()) as ApiResponse;
  let html = "html" in markdownJson ? markdownJson.html : markdownJson.error;

  return new Response(
    "<!DOCTYPE html>" + renderToString(createElement(Demo, { html })),
    {
      headers: {
        "Content-Type": "text/html",
        "Cache-Control":
          markdownResponse.headers.get("Cache-Control") || "no-cache",
      },
    }
  );
}

async function renderDemo(
  request: Request,
  ctx: ExecutionContext
): Promise<Response> {
  let url = new URL(request.url);
  let domain = new URL("/", url).href;
  let file = url.pathname.slice("/_demo".length);

  let markdownHeaders = new Headers();
  request.headers.has("Cache-Control") &&
    markdownHeaders.append(
      "Cache-Control",
      request.headers.get("Cache-Control")!
    );
  let markdownResponse = await renderMarkdown(
    new Request(new URL(file, domain).href, {
      headers: markdownHeaders,
    }),
    ctx
  );
  let markdownJson = (await markdownResponse.json()) as ApiResponse;
  let html = "html" in markdownJson ? markdownJson.html : markdownJson.error;

  return new Response(
    "<!DOCTYPE html>" + renderToString(createElement(Demo, { html })),
    {
      headers: {
        "Content-Type": "text/html",
        "Cache-Control":
          markdownResponse.headers.get("Cache-Control") || "no-cache",
      },
    }
  );
}

async function renderFiles(
  request: Request,
  // { GITHUB_MD }: Env,
  ctx: ExecutionContext
): Promise<Response> {
  let now = Date.now();
  let url = new URL(request.url);
  let [user, repo, sha] = url.pathname.split("/").filter((s) => s !== "");

  let filesJsonKey = `files${url.pathname}`;
  let cached = shouldSkipCache(request)
    ? null
    : await readFromCache(filesJsonKey);

  let data: CachedFiles | null;
  if (cached) {
    data = cached.data as CachedFiles;

    if (cached.staleAt < now) {
      ctx.waitUntil(
        createNewFilesCacheEntry(user, repo, sha).then(
          (toCache) => toCache && writeToCache(filesJsonKey, toCache)
        )
      );
    }
  } else {
    data = await createNewFilesCacheEntry(user, repo, sha);
    if (data) {
      ctx.waitUntil(writeToCache(filesJsonKey, data));
    }
  }

  if (!data) {
    return new Response(JSON.stringify({ error: "Not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  return new Response(JSON.stringify(data), {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": `public, max-age=${
        REVALIDATE_AFTER_MS / 1000
      }, immutable`,
    },
  });
}

async function renderMarkdown(
  request: Request,
  ctx: ExecutionContext
): Promise<Response> {
  let now = Date.now();
  let url = new URL(request.url);

  let kvJsonKey = `json-swr${url.pathname}`;
  let cached = shouldSkipCache(request) ? null : await readFromCache(kvJsonKey);

  let data: ApiData | null;
  if (cached) {
    data = cached.data as ApiData;

    if (cached.staleAt < now) {
      ctx.waitUntil(
        createNewCacheEntry(url).then(
          (toCache) => toCache && writeToCache(kvJsonKey, toCache)
        )
      );
    }
  } else {
    data = await createNewCacheEntry(url);
    if (data) {
      ctx.waitUntil(writeToCache(kvJsonKey, data));
    }
  }

  if (!data) {
    return new Response(JSON.stringify({ error: "Not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  return new Response(JSON.stringify(data), {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": `public, max-age=${
        REVALIDATE_AFTER_MS / 1000
      }, immutable`,
    },
  });
}

async function readFromCache(
  key: string
): Promise<{ data: unknown; staleAt: number } | null> {
  let url = `kv://${key}`;
  let match = await caches.default.match(url, {});
  if (!match) return null;
  let data = await match.json();

  return {
    data,
    staleAt: Number(match.headers.get("Stale-At") || 0),
  };
}

async function writeToCache(key: string, value: unknown): Promise<void> {
  let url = `kv://${key}`;
  await caches.default.put(
    url,
    new Response(JSON.stringify(value), {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": `public, max-age=${STALE_FOR_SECONDS}, immutable`,
        "Stale-At": (Date.now() + REVALIDATE_AFTER_MS).toFixed(0),
      },
    })
  );
}

async function createNewCacheEntry(url: URL): Promise<Cached | null> {
  let contentResponse = await fetch(
    new URL(url.pathname, "https://raw.githubusercontent.com/").href,
    {
      headers: {
        "User-Agent": "github-md.com",
      },
    }
  );
  if (!contentResponse.ok) return null;
  let markdown = await contentResponse.text();

  return parseMarkdown(markdown);
}

async function createNewFilesCacheEntry(
  user: string,
  repo: string,
  sha: string
): Promise<CachedFiles | null> {
  let contentResponse = await fetch(
    `https://api.github.com/repos/${user}/${repo}/git/trees/${sha}?recursive=1`,
    {
      headers: {
        "User-Agent": "github-md.com",
      },
    }
  );

  if (!contentResponse.ok) return null;
  let content = (await contentResponse.json()) as {
    sha: string;
    tree: {
      path: string;
      type: "blob" | "tree";
      sha: string;
    }[];
  };

  let files = content.tree.reduce((acc, item) => {
    if (item.type === "blob" && item.path.toLocaleLowerCase().endsWith(".md")) {
      acc.push({
        path: item.path,
        sha: item.sha,
      });
    }
    return acc;
  }, [] as CachedFile[]);

  return {
    sha: content.sha,
    files: await Promise.all(files),
  };
}

function emojiReplacer(match: string) {
  return emoji.emojify(match);
}

function parseMarkdown(markdown: string): ApiData {
  let { body, attributes } = frontmatter(markdown);

  body = body.replace(/(:.*:)/g, emojiReplacer);

  let html = marked(body, {
    highlight: (code, language) => {
      if (language && hljs.getLanguage(language)) {
        try {
          return hljs.highlight(code, { language }).value;
        } catch (__) {}
      }
      return code;
    },
    langPrefix: "hljs language-",
    gfm: true,
    headerIds: true,
    smartLists: true,
  });
  html = sanitize(html, {
    allowedTags: [
      "address",
      "article",
      "aside",
      "footer",
      "header",
      "h1",
      "h2",
      "h3",
      "h4",
      "h5",
      "h6",
      "hgroup",
      "main",
      "nav",
      "section",
      "blockquote",
      "img",
      "dd",
      "div",
      "dl",
      "dt",
      "figcaption",
      "figure",
      "hr",
      "li",
      "main",
      "ol",
      "p",
      "pre",
      "ul",
      "a",
      "abbr",
      "b",
      "bdi",
      "bdo",
      "br",
      "cite",
      "code",
      "data",
      "dfn",
      "em",
      "i",
      "kbd",
      "mark",
      "q",
      "rb",
      "rp",
      "rt",
      "rtc",
      "ruby",
      "s",
      "samp",
      "small",
      "span",
      "strong",
      "sub",
      "sup",
      "time",
      "u",
      "var",
      "wbr",
      "caption",
      "col",
      "colgroup",
      "table",
      "tbody",
      "td",
      "tfoot",
      "th",
      "thead",
      "tr",
    ],
    disallowedTagsMode: "discard",
    allowedAttributes: {
      "*": ["class", "id", "style"],
      a: ["href", "name", "target"],
      // We don't currently allow img itself by default, but
      // these attributes would make sense if we did.
      img: ["src", "srcset", "alt", "title", "width", "height", "loading"],
    },
    // Lots of these won't come up by default because we don't allow them
    selfClosing: [
      "img",
      "br",
      "hr",
      "area",
      "base",
      "basefont",
      "input",
      "link",
      "meta",
    ],
    // URL schemes we permit
    allowedSchemes: ["http", "https", "ftp", "mailto", "tel"],
    allowedSchemesByTag: {},
    allowedSchemesAppliedToAttributes: ["href", "src", "cite"],
    allowProtocolRelative: true,
    enforceHtmlBoundary: true,
  });

  return { attributes, html };
}

function shouldSkipCache(request: Request): boolean {
  let hasNoCache =
    request.headers.get("Cache-Control")?.toLowerCase().includes("no-cache") ||
    request.headers.get("pragma")?.toLowerCase().includes("no-cache") ||
    false;

  return hasNoCache;
}
