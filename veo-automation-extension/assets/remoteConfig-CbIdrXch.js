function t(t, n) {
  return t.version.split(",").map(t => t.trim()).filter(Boolean).includes(n.trim());
}
let n = null;
async function e(t) {
  const n = await fetch(`${t}/config/flow-automation`, {
    method: "GET",
    headers: {
      "X-Client-Secret": "YES_THAT_IS_VERY_EASY_RIGHT_?!$"
    }
  });
  if (!n.ok) {
    throw new Error(`HTTP ${n.status}`);
  }
  const e = await n.json();
  if (!e?.selectors) {
    throw new Error("Invalid config shape");
  }
  return e;
}
// The CDN still serves selectors for the retired labs.google DOM. Verified against the
// live flow.google.com project page: `button:has(i:contains("arrow_forward"))` matches 0
// elements (the page renders Material Symbols, there is not a single <i>), and
// `div[role="textbox"]` matches 0 elements. The replacements below match exactly 1 each.
// Original TypeScript is not in this repo, so this override lives here.
const FLOW_SELECTOR_OVERRIDES = {
  promptTextarea: 'div.ProseMirror[contenteditable="true"]',
  submitButton: 'button[aria-label="Start generation"]',
  configButton: 'button:has(mat-icon:contains("crop")), button:has(mat-icon:contains("tune"))',
  configButtonActived: 'button:has(mat-icon:contains("crop")), button:has(mat-icon:contains("tune"))',
  configureUIModeButton: 'button:has(mat-icon:contains("settings_2"))',
  uploadMediaButton: 'button:has(mat-icon:contains("upload")):last()',
  charactersTabButton: 'button:has(mat-icon:contains("accessibility_new"))',
  tileOnQueue: 'mat-icon:contains("movie"), div[style*="brightness(1)"]',
  selectImageMode: '[role="radio"]:has(mat-icon:contains("image"))',
  selectVideoMode: '[role="radio"]:has(mat-icon:contains("videocam"))',
  aspectRatioTemplate: '[role="radio"]:contains("{aspectRatio}")',
  outputCountTemplate: '[role="radio"]:contains("{outputCount}")',
  modelSelectButton: 'button[aria-label="Select model family"]'
};
function applyFlowOverrides(cfg) {
  if (cfg && cfg.selectors) {
    for (const k of Object.keys(FLOW_SELECTOR_OVERRIDES)) {
      cfg.selectors[k] = FLOW_SELECTOR_OVERRIDES[k];
    }
  }
  return cfg;
}
async function r() {
  if (n) {
    return n;
  }
  try {
    n = applyFlowOverrides(await e("https://configs.kylenguyen.me"));
    return n;
  } catch (t) {}
  try {
    n = applyFlowOverrides(await e("https://extension-config.onegreen.workers.dev"));
    return n;
  } catch (t) {
    return null;
  }
}
export { r as g, t as i };