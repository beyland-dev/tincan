import "lite-youtube-embed";
import "lite-youtube-embed/src/lite-yt-embed.css";

/** The parts of lite-youtube-embed's element class that Tincan changes. */
type LiteYouTube = CustomElementConstructor & {
  preconnected?: boolean;
  warmConnections?: () => void;
  prototype: HTMLElement & {
    createBasicIframe: (this: HTMLElement) => HTMLIFrameElement;
    upgradePosterImage: () => void;
  };
};

/**
 * The flags the YouTube player needs to play: its own scripts and origin, presentation (casting),
 * and popups so "Watch on YouTube" can open (the main process sends those to the browser).
 */
export const PLAYER_SANDBOX = "allow-scripts allow-same-origin allow-presentation allow-popups";

const element = customElements.get("lite-youtube") as LiteYouTube | undefined;
if (element) {
  // Hovering a player would otherwise preconnect to youtube-nocookie.com, google.com and two
  // DoubleClick hosts before anyone presses play. Nothing connects until the player is started.
  element.preconnected = true;
  element.warmConnections = () => {};
  // Tincan passes the poster it already fetched (or none); never fetch a better one from ytimg.
  element.prototype.upgradePosterImage = () => {};
  const createIframe = element.prototype.createBasicIframe;
  element.prototype.createBasicIframe = function (this: HTMLElement) {
    const iframe = createIframe.call(this);
    iframe.setAttribute("sandbox", PLAYER_SANDBOX);
    return iframe;
  };
}
