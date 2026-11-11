(async () => {
  const theme = new URLSearchParams(location.search).get("theme");
  const [screen, state = "default"] = location.hash.slice(1).split("/");
  const response = await fetch(
    "fragments/" + screen + "--" + state + "--" + theme + "--phone.html",
  );
  if (!response.ok) throw new Error("no derived frame for " + location.hash);
  const app = document.getElementById("app");
  app.innerHTML = await response.text();
  app.dataset.screen = screen;
  app.dataset.state = state;
  await document.fonts.ready;
  globalThis.bakeryWorkerDarkReady = true;
})();
