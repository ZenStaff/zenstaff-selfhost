// The invitation page: the token is in the fragment (#...), which the browser never sends to the
// hub on its own. This script asks the hub who invites to which company (POST, token in the body),
// carries the fragment (and the page's language) to the dashboard's accept page and to the other
// language, and copies the whole link for the app.
const ro = document.documentElement.lang !== "en";
const hash = location.hash.length > 1 ? location.hash : "";
const accept = document.getElementById("accept");
if (accept !== null && hash !== "") accept.href = `${accept.getAttribute("href")}${hash}`;
const other = document.getElementById("other-lang");
if (other !== null && hash !== "") other.href = `${other.getAttribute("href")}${hash}`;

const copy = document.getElementById("copy-link");
if (copy !== null) {
  copy.addEventListener("click", () => {
    const done = () => {
      copy.textContent = ro ? "Linkul e copiat" : "Link copied";
    };
    if (navigator.clipboard) navigator.clipboard.writeText(location.href).then(done, () => undefined);
  });
}

const title = document.getElementById("invite-title");
const who = document.getElementById("invite-who");
if (hash !== "" && title !== null && who !== null) {
  fetch("/v1/invites/preview", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: hash.slice(1) }),
  })
    .then((response) => (response.ok ? response.json() : null))
    .then((invite) => {
      if (invite === null) {
        who.textContent = ro
          ? "Invitația nu mai e valabilă. Cere-i celui care te-a invitat un link nou."
          : "This invitation is no longer valid. Ask the person who invited you for a new link.";
        return;
      }
      const role = ro ? invite.roleName.ro : invite.roleName.en;
      title.textContent = ro ? `Intră în ${invite.companyName}` : `Join ${invite.companyName}`;
      who.textContent = ro
        ? `${invite.inviter} te-a invitat în ${invite.companyName}, ca ${role}.`
        : `${invite.inviter} invited you to ${invite.companyName}, as ${role}.`;
      if (typeof invite.email === "string") {
        const line = document.createElement("p");
        line.className = "note";
        line.textContent = ro ? `Intră cu adresa ${invite.email}.` : `Sign in with ${invite.email}.`;
        who.after(line);
      }
    })
    .catch(() => undefined);
}
