import { accessPolicy, exactOrigins } from "./access.js";

const form = document.querySelector("form");
const scope = document.querySelector("#website-scope");
const approvedSites = document.querySelector("#approved-sites");
const allSitesNotice = document.querySelector("#all-sites-notice");
const origins = document.querySelector("#origins");
const blocked = document.querySelector("#blocked");
const status = document.querySelector("#status");
const feedback = document.querySelector("#feedback");

function showScope() {
  const allowAll = scope.value === "all";
  approvedSites.hidden = allowAll;
  origins.disabled = allowAll;
  allSitesNotice.hidden = !allowAll;
}

function showFeedback(message, isError = false) {
  feedback.textContent = message;
  feedback.dataset.error = String(isError);
  feedback.hidden = !message;
}

function showAccessState(access) {
  status.textContent = access.paused ? "Access paused" : "Access enabled";
  status.dataset.active = String(!access.paused);
}

async function show() {
  const access = await accessPolicy(chrome);
  const { lastError = "" } = await chrome.storage.local.get("lastError");
  scope.value = access.allSites ? "all" : "approved";
  origins.defaultValue = access.origins.join("\n");
  blocked.value = access.blocked.join("\n");
  showScope();
  showAccessState(access);
  showFeedback(lastError, Boolean(lastError));
}
scope.addEventListener("change", showScope);
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const allowAll = scope.value === "all";
  let field = blocked;
  try {
    const blockedOrigins = exactOrigins(blocked.value);
    field = origins;
    const approvedOrigins = exactOrigins(
      allowAll ? origins.defaultValue : origins.value,
    );
    const access = {
      paused: false,
      allSites: allowAll,
      origins: approvedOrigins,
      blocked: blockedOrigins,
    };
    if (!allowAll && !approvedOrigins.length)
      throw Error("Approve at least one origin");
    await chrome.storage.local.set({ access });
    origins.defaultValue = approvedOrigins.join("\n");
    origins.value = origins.defaultValue;
    showAccessState(access);
    showFeedback("Reconnect any open MCP sessions to apply changes.");
  } catch (error) {
    showFeedback(error.message, true);
    field.focus();
  }
});
document.querySelector("#pause").addEventListener("click", async () => {
  try {
    const access = { ...(await accessPolicy(chrome)), paused: true };
    await chrome.storage.local.set({ access });
    showAccessState(access);
    showFeedback("Open MCP sessions are disconnecting.");
  } catch (error) {
    showFeedback(error.message, true);
  }
});
await show();
