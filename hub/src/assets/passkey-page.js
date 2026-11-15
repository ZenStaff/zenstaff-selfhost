// The hub's passkey page: runs the WebAuthn ceremony (navigator.credentials.create or .get through
// @simplewebauthn/browser, vendored next to this file) and reports to the hub. The texts come from
// the page itself (data-* attributes), already in the person's language.
/* global SimpleWebAuthnBrowser */
(() => {
  const data = document.body.dataset;
  const title = document.getElementById("title");
  const text = document.getElementById("text");
  const button = document.getElementById("go");
  const status = document.getElementById("status");
  const lib = globalThis.SimpleWebAuthnBrowser;

  if (lib === undefined || !lib.browserSupportsWebAuthn()) {
    button.hidden = true;
    status.textContent = data.unsupported;
    return;
  }

  const post = async (path, body) => {
    const response = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      credentials: "omit",
    });
    const json = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(typeof json.error === "string" ? json.error : "failed");
      error.code = typeof json.code === "string" ? json.code : null;
      throw error;
    }
    return json;
  };

  const messageFor = (error) => {
    if (error && error.code === "passkey_expired") return data.expired;
    if (error && error.code === "passkey_refused") return data.refused;
    if (error && error.code === "rate_limited") return data.limited;
    if (error && (error.name === "NotAllowedError" || error.name === "AbortError")) return data.cancelled;
    if (error && error.name === "InvalidStateError") return data.duplicate;
    return data.failed;
  };

  button.addEventListener("click", async () => {
    button.disabled = true;
    status.textContent = data.working;
    try {
      const mode = data.mode;
      const { options } = await post(`${mode}/options`, { t: data.token });
      const response =
        mode === "register"
          ? await lib.startRegistration({ optionsJSON: options })
          : await lib.startAuthentication({ optionsJSON: options });
      await post(`${mode}/finish`, { t: data.token, response });
      title.textContent = data.doneTitle;
      text.textContent = data.doneText;
      status.textContent = "";
      button.hidden = true;
    } catch (error) {
      status.textContent = messageFor(error);
      button.disabled = error && error.code === "passkey_expired";
    }
  });
})();
