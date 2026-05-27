const crypto = require("node:crypto");

function buildAdminCsrfToken(sessionToken, config) {
  if (!sessionToken) return "";
  return crypto
    .createHmac("sha256", `${config.admin.username}:${config.admin.password}:csrf`)
    .update(`admin-csrf-v1:${sessionToken}`)
    .digest("base64url");
}

function getAdminSessionToken(request) {
  return parseCookies(request.headers.cookie || "").admin_session || "";
}

function verifyAdminCsrfToken(request, config) {
  const sessionToken = getAdminSessionToken(request);
  const provided = request.headers["x-csrf-token"];
  const expected = buildAdminCsrfToken(sessionToken, config);
  return Boolean(sessionToken && provided && constantTimeEqual(provided, expected));
}

function parseCookies(header) {
  const cookies = {};
  for (const part of String(header || "").split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (name) cookies[name] = value;
  }
  return cookies;
}

function constantTimeEqual(a, b) {
  const left = Buffer.from(String(a || ""));
  const right = Buffer.from(String(b || ""));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

module.exports = {
  buildAdminCsrfToken,
  getAdminSessionToken,
  verifyAdminCsrfToken,
};
