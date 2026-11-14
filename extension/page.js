// Runs only in Chrome's ISOLATED world, in the explicitly requested top frame.
(() => {
  if (globalThis.__cdpBrowserPoc) return;
  const state = {
    refs: new Map(),
    documentId: crypto.randomUUID().slice(0, 8),
  };
  globalThis.__cdpBrowserPoc = state;
  const visible = (e) =>
    e.getClientRects().length > 0 &&
    getComputedStyle(e).visibility !== "hidden";
  const name = (e) =>
    e.getAttribute("aria-label") ||
    (e.labels ? [...e.labels].map((l) => l.innerText).join(" ") : "") ||
    e.getAttribute("alt") ||
    e.getAttribute("placeholder") ||
    e.innerText ||
    "";
  function snapshot() {
    state.refs.clear();
    const lines = [];
    for (const e of document.querySelectorAll(
      "h1,h2,h3,h4,h5,h6,a,button,input,textarea,select,[role],[contenteditable=true]",
    )) {
      if (!visible(e)) continue;
      const ref = `${state.documentId}-e${state.refs.size + 1}`;
      state.refs.set(ref, e);
      const role =
        e.getAttribute("role") ||
        {
          A: "link",
          BUTTON: "button",
          INPUT: e.type === "checkbox" ? "checkbox" : "textbox",
          TEXTAREA: "textbox",
          SELECT: "combobox",
        }[e.tagName] ||
        e.tagName.toLowerCase();
      lines.push(
        `- ${role} ${JSON.stringify(name(e).trim().slice(0, 300))} [ref=${ref}]`,
      );
      if (lines.length >= 1000) break;
    }
    return {
      url: location.href,
      title: document.title,
      snapshot: lines.join("\n"),
      snapshotKind:
        "DOM semantic summary (top frame), not a full accessibility tree",
    };
  }
  function target(args) {
    let e;
    if (args.ref) e = state.refs.get(args.ref);
    else if (args.selector) {
      const matches = document.querySelectorAll(args.selector);
      if (matches.length !== 1)
        throw Error(
          `Selector must match exactly one element; got ${matches.length}`,
        );
      e = matches[0];
    }
    if (!e || !e.isConnected || !visible(e))
      throw Error("Element is absent, stale or hidden; take a fresh snapshot");
    return e;
  }
  async function run(action, args) {
    if (action === "snapshot") return snapshot();
    if (action === "extract") {
      const e = document.querySelector(args.selector || "body");
      if (!e) throw Error("Extract selector did not match");
      return { text: e.innerText.slice(0, 100000), url: location.href };
    }
    const e = target(args);
    e.scrollIntoView({ block: "center" });
    if (action === "click") {
      if (e.disabled) throw Error("Element is disabled");
      e.click();
    } else if (action === "type") {
      if (args.slowly)
        throw Error(
          "Extension PoC does not synthesize trusted keyboard events; slowly is unsupported",
        );
      e.focus();
      if (e instanceof HTMLInputElement || e instanceof HTMLTextAreaElement) {
        if (e.disabled || e.readOnly)
          throw Error("Field is disabled or read-only");
        Object.getOwnPropertyDescriptor(
          e instanceof HTMLInputElement
            ? HTMLInputElement.prototype
            : HTMLTextAreaElement.prototype,
          "value",
        ).set.call(e, args.text);
      } else if (e.isContentEditable) e.textContent = args.text;
      else throw Error("Element is not an editable field");
      e.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          inputType: "insertText",
          data: args.text,
        }),
      );
      e.dispatchEvent(new Event("change", { bubbles: true }));
      if (args.submit) {
        if (!e.form) throw Error("submit requires a form-associated field");
        e.form.requestSubmit();
      }
    } else throw Error(`Unknown page action: ${action}`);
    return snapshot();
  }
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id || message.kind !== "page-action")
      return;
    void run(message.action, message.args).then(respond, (error) =>
      respond({ error: error.message }),
    );
    return true;
  });
})();
