import { describe, expect, test } from "vite-plus/test";
import {
  allowedRedirect,
  allowedUrl,
  decodeEntities,
  fetchPreview,
  fitImage,
  imageSize,
  setImageResizer,
  isPublicAddress,
  isWebUrl,
  parsePreview,
  specialLink,
  youtubeStart,
} from "../src/main/preview.ts";

describe("link previews", () => {
  test("only public addresses are reachable", () => {
    for (const address of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"]) {
      expect(isPublicAddress(address)).toBe(true);
    }
    for (const address of [
      "127.0.0.1",
      "10.1.2.3",
      "172.20.0.1",
      "192.168.1.1",
      "169.254.169.254",
      "100.100.1.1",
      "0.0.0.0",
      "224.0.0.1",
      "::1",
      "::",
      "fe80::1",
      "fd12::1",
      "::ffff:127.0.0.1",
      "0:0:0:0:0:ffff:0808:0808",
      // IPv4-compatible (deprecated), IPv4-translated, NAT64 and 6to4 all embed IPv4 addresses.
      "::127.0.0.1",
      "::7f00:1",
      "::8.8.8.8",
      "::ffff:0:7f00:1",
      "64:ff9b::7f00:1",
      "64:ff9b:1::1",
      "2002:7f00:1::1",
      "2002:c0a8:101::1",
      // Teredo, ORCHID, benchmarking and documentation.
      "2001::1",
      "2001:0:4136:e378:8000:63bf:3fff:fdd2",
      "2001:2::1",
      "2001:20::1",
      "2001:db8::1",
      "3fff::1",
      // Unique local, site-local, multicast and the 6to4 relay.
      "fc00::1",
      "fec0::1",
      "ff02::1",
      "192.88.99.1",
      "198.18.0.1",
      "not an ip",
    ]) {
      expect(isPublicAddress(address), address).toBe(false);
    }
    expect(isPublicAddress("2001:4860:4860::8888")).toBe(true);
  });

  test("literal addresses in URLs go through the same checks", () => {
    for (const raw of [
      "https://[::127.0.0.1]/",
      "https://[::ffff:127.0.0.1]/",
      "https://[64:ff9b::a00:1]/",
      "https://[2002:a00:1::]/",
      "https://[2001::1]/",
      "https://[fec0::1]/",
      "https://0x7f.1/",
      "https://2130706433/",
    ]) {
      expect(allowedUrl(raw), raw).toBeNull();
    }
    expect(allowedUrl("https://[2606:4700:4700::1111]/")).not.toBeNull();
  });

  test("redirects can't drop from https to http or leave the public internet", () => {
    const secure = new URL("https://example.com/a");
    expect(allowedRedirect(secure, "https://example.org/b")?.href).toBe("https://example.org/b");
    expect(allowedRedirect(secure, "http://example.org/b")).toBeNull();
    expect(allowedRedirect(secure, "https://127.0.0.1/")).toBeNull();
    expect(allowedRedirect(secure, "https://[::1]/")).toBeNull();
    expect(allowedRedirect(secure, "file:///etc/passwd")).toBeNull();
  });

  test("reads image sizes from headers and refuses pixel bombs", () => {
    const png = (w: number, h: number) => {
      const b = Buffer.alloc(33);
      Buffer.from("89504e470d0a1a0a", "hex").copy(b, 0);
      b.writeUInt32BE(13, 8);
      b.write("IHDR", 12, "latin1");
      b.writeUInt32BE(w, 16);
      b.writeUInt32BE(h, 20);
      return b;
    };
    const gif = Buffer.from("GIF89a\x40\x01\xf0\x00", "latin1");
    const jpeg = Buffer.from([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0xe0,
      0x02, 0x80, 0x03,
    ]);
    expect(imageSize(png(1200, 630), "image/png")).toEqual({ width: 1200, height: 630 });
    expect(imageSize(gif, "image/gif")).toEqual({ width: 320, height: 240 });
    expect(imageSize(jpeg, "image/jpeg")).toEqual({ width: 640, height: 480 });
    expect(imageSize(Buffer.from("nope"), "image/png")).toBeNull();
    expect(imageSize(png(0, 10), "image/png")).toBeNull();

    // Within limits: kept as is (no resizer outside Electron), or scaled when one is set.
    expect(fitImage(png(800, 600), "image/png")?.body.length).toBe(33);
    expect(fitImage(png(50_000, 50_000), "image/png")).toBeNull();
    expect(fitImage(Buffer.from("garbage!"), "image/jpeg")).toBeNull();
    let asked: number | undefined;
    setImageResizer((_body, type, max) => {
      asked = max;
      return { body: Buffer.from("small"), type };
    });
    try {
      expect(fitImage(png(3000, 2000), "image/png")?.body.toString()).toBe("small");
      expect(asked).toBe(960);
      // GIFs may be animated, so they're never re-encoded.
      expect(fitImage(Buffer.from("GIF89a\x00\x08\x00\x08", "latin1"), "image/gif")?.type).toBe(
        "image/gif",
      );
    } finally {
      setImageResizer(null);
    }
  });

  test("only https URLs to non-local hosts are fetched", () => {
    expect(allowedUrl("https://example.com/a")?.hostname).toBe("example.com");
    expect(allowedUrl("HTTPS://example.com/a")?.hostname).toBe("example.com");
    // Plain http links get no preview (they stay clickable).
    expect(allowedUrl("http://example.com")).toBeNull();
    expect(allowedUrl("http://example.com:443/")).toBeNull();
    expect(allowedUrl("file:///etc/passwd")).toBeNull();
    expect(allowedUrl("javascript:alert(1)")).toBeNull();
    expect(allowedUrl("https://127.0.0.1:8080/")).toBeNull();
    expect(allowedUrl("https://[::1]/")).toBeNull();
    expect(allowedUrl("https://localhost:3000")).toBeNull();
    expect(allowedUrl("https://user:pw@example.com")).toBeNull();
    expect(allowedUrl("not a url")).toBeNull();
    expect(isWebUrl("http://192.168.1.1")).toBe(true);
    expect(isWebUrl("http://example.com")).toBe(true);
    expect(isWebUrl("file:///etc/passwd")).toBe(false);
  });

  test("Open Graph tags make the preview, resolving the image against the page", () => {
    const html = `<html><head>
      <title>Fallback</title>
      <meta property="og:title" content="Tom &amp; Jerry&#39;s &quot;Day&quot;">
      <meta content='A  short
        description' property='og:description'>
      <meta property="og:site_name" content="Example">
      <meta property="og:image" content="/img/card.png">
    </head></html>`;
    expect(parsePreview(html, "https://example.com/post/1")).toEqual({
      url: "https://example.com/post/1",
      title: `Tom & Jerry's "Day"`,
      description: "A short description",
      siteName: "Example",
      imageUrl: "https://example.com/img/card.png",
    });
  });

  test("falls back to the page title, and gives nothing without one", () => {
    expect(parsePreview("<title> Just a title </title>", "https://a.example/")).toEqual({
      url: "https://a.example/",
      title: "Just a title",
    });
    expect(parsePreview("<p>no head</p>", "https://a.example/")).toBeNull();
    const bad = parsePreview(
      `<meta property="og:title" content="T"><meta property="og:image" content="javascript:x">`,
      "https://a.example/",
    );
    expect(bad?.imageUrl).toBeUndefined();
  });

  test("only uses https images, dropping http ones even on an https page", () => {
    const page = (image: string) =>
      parsePreview(
        `<meta property="og:title" content="T"><meta property="og:image" content="${image}">`,
        "https://a.example/post",
      );
    expect(page("http://cdn.example/card.png")).toEqual({
      url: "https://a.example/post",
      title: "T",
    });
    expect(page("//cdn.example/card.png")?.imageUrl).toBe("https://cdn.example/card.png");
    expect(page("https://cdn.example/card.png")?.imageUrl).toBe("https://cdn.example/card.png");
  });

  test("never fetches a plain http link", async () => {
    expect(await fetchPreview("http://example.com/")).toBeNull();
  });

  test("decodes named and numeric entities", () => {
    expect(decodeEntities("a&nbsp;b &#x1F600; &#8212; &bogus;")).toBe("a b 😀 — &bogus;");
  });

  test("recognises GIPHY, YouTube and Bluesky links", () => {
    const of = (raw: string) => specialLink(new URL(raw));
    expect(of("https://giphy.com/gifs/theoffice-michael-scott-3o7aCRloybJlXpNjSU")).toEqual({
      kind: "giphy",
      id: "3o7aCRloybJlXpNjSU",
    });
    expect(of("https://media2.giphy.com/media/3o7aCRloybJlXpNjSU/giphy.gif")).toEqual({
      kind: "giphy",
      id: "3o7aCRloybJlXpNjSU",
    });
    expect(of("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1m30s")).toEqual({
      kind: "youtube",
      id: "dQw4w9WgXcQ",
      start: 90,
    });
    expect(of("https://youtu.be/dQw4w9WgXcQ")).toEqual({ kind: "youtube", id: "dQw4w9WgXcQ" });
    expect(of("https://youtube.com/shorts/dQw4w9WgXcQ?si=x")).toEqual({
      kind: "youtube",
      id: "dQw4w9WgXcQ",
    });
    expect(of("https://bsky.app/profile/danabra.mov/post/3mizn3e7mzk2z")).toEqual({
      kind: "bluesky",
      actor: "danabra.mov",
      rkey: "3mizn3e7mzk2z",
    });
    expect(of("https://www.youtube.com/watch?v=short")).toBeNull();
    expect(of("https://bsky.app/profile/danabra.mov")).toBeNull();
    expect(of("https://example.com/gifs/abc")).toBeNull();
  });

  test("reads YouTube start times", () => {
    expect(youtubeStart("90")).toBe(90);
    expect(youtubeStart("45s")).toBe(45);
    expect(youtubeStart("1h2m3s")).toBe(3723);
    expect(youtubeStart("soon")).toBeUndefined();
    expect(youtubeStart(null)).toBeUndefined();
  });
});
