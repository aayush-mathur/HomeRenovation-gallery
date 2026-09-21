"use strict";

const byId = (id) => document.getElementById(id);
const collectionSelect = byId("collection");
const roomSelect = byId("room");
const viewer = byId("viewer");
let collections = [];
let activeCollection;
let visibleViews = [];
let activeIndex = 0;
let returnFocus;
let imageRequest = 0;
let modelRequest = 0;
let modelElement;
let modelTimeout;
let viewerModule;
let modelAttempt = 0;

function releaseModel() {
  ++modelRequest;
  clearTimeout(modelTimeout);
  modelElement?.remove();
  modelElement = undefined;
  byId("model-mount").replaceChildren();
  byId("model-controls").hidden = true;
  byId("model-poster").hidden = false;
}

function configureModel() {
  releaseModel();
  const model = activeCollection.model;
  byId("model-section").hidden = !model;
  byId("load-model").disabled = false;
  byId("load-model").hidden = false;
  byId("load-model").textContent = "Load interactive model";
  byId("model-state").textContent = "";
  if (!model) return;
  byId("model-poster").src = model.poster;
  byId("model-summary").textContent = `${(model.bytes / 1000000).toFixed(1)} MB model · Loads only when you choose · No Blender needed`;
  byId("model-state").textContent = "Rendered preview shown. Load 3D to rotate and zoom.";
}

function setModelFailure(request, error) {
  if (request !== modelRequest) return;
  console.error("Interactive kitchen viewer failed:", error);
  ++modelAttempt;
  releaseModel();
  byId("model-state").textContent = "3D could not load. Try again, or use the rendered reference below. Your browser needs WebGL / hardware acceleration.";
  byId("load-model").disabled = false;
  byId("load-model").hidden = false;
  byId("load-model").textContent = "Retry 3D";
}

async function loadModel() {
  releaseModel();
  const request = modelRequest;
  const model = activeCollection.model;
  if (!model) return;
  byId("load-model").disabled = true;
  byId("model-state").textContent = "Loading the local 3D viewer…";
  modelTimeout = setTimeout(() => setModelFailure(request, new Error("3D load timed out")), 45000);
  try {
    viewerModule ||= import("./vendor/model-viewer.min.js").catch((error) => {
      viewerModule = undefined;
      throw error;
    });
    await viewerModule;
    await customElements.whenDefined("model-viewer");
    if (request !== modelRequest) return;
    customElements.get("model-viewer").modelCacheSize = 0;
    const element = document.createElement("model-viewer");
    modelElement = element;
    const attributes = {
      alt: model.label, "camera-controls": "", "touch-action": "pan-y",
      "interaction-prompt": "none", "camera-orbit": "35deg 55deg auto",
      "camera-target": "auto auto auto", "min-camera-orbit": "auto 0deg 1m",
      "max-camera-orbit": "auto 85deg 15m", "shadow-intensity": "1",
      exposure: "1", "environment-image": "neutral", loading: "eager",
      reveal: "auto", "aria-describedby": "model-help",
    };
    Object.entries(attributes).forEach(([key, value]) => element.setAttribute(key, value));
    element.addEventListener("progress", (event) => {
      if (request !== modelRequest || element.loaded) return;
      const progress = event.detail?.totalProgress;
      byId("model-state").textContent = Number.isFinite(progress)
        ? `Loading 3D model… ${Math.round(progress * 100)}%`
        : "Loading 3D model…";
    });
    element.addEventListener("error", (event) => setModelFailure(request, event.detail || event));
    element.addEventListener("load", () => {
      if (request !== modelRequest) return;
      clearTimeout(modelTimeout);
      byId("model-poster").hidden = true;
      byId("model-controls").hidden = false;
      byId("load-model").hidden = true;
      byId("model-state").textContent = "3D ready. Drag the kitchen to rotate.";
      byId("fullscreen-model").hidden = !document.fullscreenEnabled;
    }, { once: true });
    const source = new URL(model.src, document.baseURI);
    // A failed GLTF load can stay in the viewer's URL cache; retries need a new key.
    if (modelAttempt) source.searchParams.set("retry", String(modelAttempt));
    element.setAttribute("src", source.href);
    byId("model-mount").append(element);
  } catch (error) {
    setModelFailure(request, error);
  }
}

byId("load-model").addEventListener("click", loadModel);
document.querySelectorAll("[data-orbit]").forEach((button) => {
  button.addEventListener("click", async () => {
    if (!modelElement) return;
    const element = modelElement;
    element.cameraTarget = "auto auto auto";
    element.cameraOrbit = button.dataset.orbit;
    await element.updateComplete;
    if (element === modelElement) element.jumpCameraToGoal();
  });
});
async function zoomModel(factor) {
  if (!modelElement) return;
  const element = modelElement;
  const orbit = element.getCameraOrbit();
  const radius = Math.max(1, Math.min(15, orbit.radius * factor));
  element.cameraOrbit = `${orbit.theta}rad ${orbit.phi}rad ${radius}m`;
  await element.updateComplete;
  if (element === modelElement) element.jumpCameraToGoal();
}
byId("zoom-in-model").addEventListener("click", () => zoomModel(0.8));
byId("zoom-out-model").addEventListener("click", () => zoomModel(1.25));
byId("unload-model").addEventListener("click", () => {
  configureModel();
  byId("load-model").focus();
});
byId("fullscreen-model").addEventListener("click", async () => {
  try {
    await byId("model-stage").requestFullscreen();
  } catch (error) {
    console.error("Full-screen viewer failed:", error);
    byId("model-state").textContent = "Full screen is unavailable here. You can still rotate and zoom in this page.";
  }
});
byId("exit-model-fullscreen").addEventListener("click", async () => {
  try {
    await document.exitFullscreen();
  } catch (error) {
    console.error("Leaving full screen failed:", error);
    byId("model-state").textContent = "Use your browser's exit-full-screen control to return to the gallery.";
  }
});

function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text) element.textContent = text;
  if (className) element.className = className;
  return element;
}

function imageLink(view, download = false) {
  const format = view.src.endsWith(".svg") ? "SVG" : "PNG";
  const link = node("a", download ? `Download ${format}` : "Open full image");
  link.href = view.src;
  if (download) link.download = view.src.split("/").pop();
  else {
    link.target = "_blank";
    link.rel = "noopener";
    link.append(node("span", " (new tab)", "sr-only"));
  }
  link.setAttribute("aria-label", `${download ? `Download ${format}` : "Open full image in new tab"}: ${view.title}`);
  return link;
}

function renderPhotos() {
  visibleViews = activeCollection.views.filter((view) => roomSelect.value === "all" || view.room === roomSelect.value);
  byId("photos").replaceChildren();
  byId("view-count").textContent = `${visibleViews.length} ${visibleViews.length === 1 ? "render" : "renders"} · Tap an image to enlarge`;
  visibleViews.forEach((view, index) => {
    const figure = node("figure");
    const button = node("button", "", "photo-button");
    button.type = "button";
    button.setAttribute("aria-label", `Enlarge ${view.title} — ${activeCollection.status}`);
    const image = node("img");
    image.alt = view.title;
    image.width = view.width;
    image.height = view.height;
    image.loading = index < 2 ? "eager" : "lazy";
    image.decoding = "async";
    const state = node("span", "Loading image…", "image-state");
    image.addEventListener("load", () => { state.hidden = true; });
    image.addEventListener("error", () => {
      state.hidden = false;
      state.textContent = "Image could not load. Open the full image or reload the page to retry.";
      image.style.visibility = "hidden";
    });
    image.src = view.src;
    button.append(image, state, node("span", "Enlarge", "enlarge-hint"));
    button.addEventListener("click", () => {
      returnFocus = button;
      activeIndex = index;
      viewer.showModal();
      document.body.classList.add("viewer-open");
      showImage();
    });
    const caption = node("figcaption");
    const links = node("div", "", "image-links");
    links.append(imageLink(view), imageLink(view, true));
    caption.append(node("h3", view.title), node("p", view.description), links);
    figure.append(button, caption);
    byId("photos").append(figure);
  });
}

function selectCollection() {
  activeCollection = collections.find((collection) => collection.id === collectionSelect.value);
  byId("collection-title").textContent = activeCollection.title;
  byId("collection-status").textContent = activeCollection.status;
  byId("collection-description").textContent = activeCollection.description;
  byId("assumptions").hidden = !activeCollection.assumptions.length;
  byId("assumptions").open = false;
  byId("assumption-list").replaceChildren(...activeCollection.assumptions.map((text) => node("li", text)));
  byId("baseline-link").hidden = activeCollection.id === "baseline";
  roomSelect.replaceChildren(new Option("All views", "all"));
  [...new Set(activeCollection.views.map((view) => view.room))].forEach((room) => {
    roomSelect.add(new Option(room, room));
  });
  configureModel();
  renderPhotos();
}

function showImage() {
  const view = visibleViews[activeIndex];
  const isSheet = view.src.endsWith(".svg");
  viewer.classList.toggle("dimension-view", isSheet);
  byId("open-sheet").hidden = !isSheet;
  byId("open-sheet").href = view.src;
  const request = ++imageRequest;
  const image = byId("viewer-image");
  const state = byId("viewer-image-state");
  state.hidden = false;
  state.textContent = "Loading full image…";
  image.hidden = true;
  image.onload = () => {
    if (request !== imageRequest) return;
    state.hidden = true;
    image.hidden = false;
  };
  image.onerror = () => {
    if (request !== imageRequest) return;
    state.hidden = false;
    state.textContent = "This image could not load. Use Open full image to retry, or choose another view.";
  };
  image.alt = view.title;
  image.src = view.src;
  byId("viewer-title").textContent = view.title;
  byId("viewer-status").textContent = `${activeCollection.title} · ${activeCollection.status}`;
  byId("viewer-caption").textContent = view.description;
  byId("viewer-position").textContent = `${activeIndex + 1} of ${visibleViews.length}`;
  byId("open-image").href = view.src;
  byId("download-image").href = view.src;
  byId("download-image").download = view.src.split("/").pop();
  byId("download-image").textContent = view.src.endsWith(".svg") ? "Download SVG" : "Download PNG";
  byId("previous").disabled = visibleViews.length < 2;
  byId("next").disabled = visibleViews.length < 2;
}

function moveImage(step) {
  activeIndex = (activeIndex + step + visibleViews.length) % visibleViews.length;
  showImage();
}

byId("close-viewer").addEventListener("click", () => viewer.close());
viewer.addEventListener("close", () => {
  ++imageRequest;
  document.body.classList.remove("viewer-open");
  returnFocus?.focus();
});
viewer.addEventListener("keydown", (event) => {
  if (event.key === "Tab") {
    const controls = [...viewer.querySelectorAll("button:not(:disabled), a[href]")]
      .filter((control) => control.getClientRects().length);
    const first = controls[0];
    const last = controls[controls.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }
  if (event.altKey || event.ctrlKey || event.metaKey) return;
  if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
    event.preventDefault();
    moveImage(event.key === "ArrowLeft" ? -1 : 1);
  }
});
byId("previous").addEventListener("click", () => moveImage(-1));
byId("next").addEventListener("click", () => moveImage(1));
collectionSelect.addEventListener("change", selectCollection);
roomSelect.addEventListener("change", renderPhotos);
byId("baseline-link").addEventListener("click", () => {
  collectionSelect.value = "baseline";
  selectCollection();
  byId("gallery").focus();
});

async function loadGallery() {
  byId("retry").hidden = true;
  byId("load-state").hidden = false;
  byId("load-state").textContent = "Loading the render collections…";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch("gallery.json", { cache: "no-cache", signal: controller.signal });
    if (!response.ok) throw new Error("Gallery data unavailable");
    const data = await response.json();
    if (data.version !== 1 || !Array.isArray(data.collections) || !data.collections.length) {
      throw new Error("Invalid gallery data");
    }
    collections = data.collections;
    collectionSelect.replaceChildren(...collections.map((collection) => new Option(collection.title, collection.id)));
    collectionSelect.value = collections.find((collection) => collection.id !== "baseline")?.id || "baseline";
    selectCollection();
    byId("content").hidden = false;
    byId("load-state").hidden = true;
  } catch {
    byId("content").hidden = true;
    byId("load-state").textContent = "The gallery could not load. Check your connection and try again. For a local preview, build the gallery and open it through the local server described below, not as a file.";
    byId("retry").hidden = false;
  } finally {
    clearTimeout(timeout);
  }
}
byId("retry").addEventListener("click", loadGallery);
loadGallery();
