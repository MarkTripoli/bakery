(async () => {
  const params = new URLSearchParams(location.search);
  const theme = params.get("theme") === "dark" ? "dark" : "light";
  document.documentElement.dataset.theme = theme;
  const [screen, state = "default"] = location.hash.slice(1).split("/");
  const device = matchMedia("(max-width: 743px)").matches ? "phone" : "desktop";
  const app = document.getElementById("app");
  const response = await fetch(
    "fragments/" + screen + "--" + state + "--" + theme + "--" + device + ".html",
  );
  if (!response.ok) throw new Error("no Paper frame for " + screen + "/" + state + "/" + theme + "/" + device);
  app.innerHTML = await response.text();
  app.dataset.screen = screen;
  app.dataset.state = state;
  await document.fonts.ready;
  const urls = new Set();
  for (const element of app.querySelectorAll("*")) {
    for (const match of getComputedStyle(element).backgroundImage.matchAll(/url\("?([^")]+)"?\)/g)) urls.add(match[1]);
  }
  await Promise.all([...urls].map(async (url) => {
    const image = new Image();
    image.src = url;
    await image.decode();
  }));
  globalThis.bakeryArtifactsReady = true;
})();
