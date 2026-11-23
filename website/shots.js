// Scales each app picture to fit its card: cropped ones (data-crop="width height") down to the
// card's box, single link cards (data-fit="width") down to the card's width, and made-to-fit
// scenes (data-scene="width height") up or down to fill the card. Without JavaScript they show at
// full size, clipped by the card.

function fit() {
  for (const shot of document.querySelectorAll(".app-shot[data-crop]")) {
    const [width, height] = shot.dataset.crop.split(" ").map(Number);
    const box = shot.parentElement;
    const scale = Math.min(1, box.clientWidth / width, box.clientHeight / height);
    shot.style.zoom = String(scale);
  }
  for (const shot of document.querySelectorAll(".app-shot[data-fit]")) {
    const width = Number(shot.dataset.fit);
    shot.style.zoom = String(Math.min(1, shot.parentElement.clientWidth / width));
  }
  for (const shot of document.querySelectorAll(".app-shot[data-scene]")) {
    const [width, height] = shot.dataset.scene.split(" ").map(Number);
    const box = shot.parentElement;
    shot.style.zoom = String(Math.min(box.clientWidth / width, box.clientHeight / height));
  }
}

fit();
addEventListener("resize", fit);
