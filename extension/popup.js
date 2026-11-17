import { accessPolicy, exactOrigins } from "./access.js";

const form = document.querySelector("form");
const origins = document.querySelector("#origins");
const blocked = document.querySelector("#blocked");
const status = document.querySelector("#status");
async function show() {
  const access = await accessPolicy(chrome);
  const { lastError = "" } = await chrome.storage.local.get("lastError");
  origins.value = access.origins.join("\n");
  blocked.value = access.blocked.join("\n");
  status.textContent = `${access.paused ? "Access paused." : "Access enabled."} ${lastError}`;
}
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const access = {
      paused: false,
      origins: exactOrigins(origins.value),
      blocked: exactOrigins(blocked.value),
    };
    if (!access.origins.length) throw Error("Approve at least one origin");
    await chrome.storage.local.set({ access });
    status.textContent =
      "Access enabled for the saved origins. Existing MCP sessions may need reconnecting after a permission change.";
  } catch (error) {
    status.textContent = error.message;
    origins.focus();
  }
});
document.querySelector("#pause").addEventListener("click", async () => {
  try {
    const access = await accessPolicy(chrome);
    await chrome.storage.local.set({ access: { ...access, paused: true } });
    status.textContent =
      "Access paused. Sessions are disconnecting; an operation already sent may have completed.";
  } catch (error) {
    status.textContent = error.message;
  }
});
await show();
