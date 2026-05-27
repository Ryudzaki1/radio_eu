const assert = require("node:assert/strict");
const {
  buildAdminCsrfToken,
  verifyAdminCsrfToken,
} = require("../src/security");

const config = {
  admin: {
    username: "admin",
    password: "admin",
  },
};

const session = "payload.signature";
const token = buildAdminCsrfToken(session, config);

assert.equal(typeof token, "string");
assert.ok(token.length > 24);
assert.equal(buildAdminCsrfToken(session, config), token);
assert.notEqual(buildAdminCsrfToken("other.signature", config), token);

assert.equal(
  verifyAdminCsrfToken({
    headers: {
      cookie: `admin_session=${session}`,
      "x-csrf-token": token,
    },
  }, config),
  true,
);

assert.equal(
  verifyAdminCsrfToken({
    headers: {
      cookie: `admin_session=${session}`,
      "x-csrf-token": "bad",
    },
  }, config),
  false,
);

console.log("smoke-tests ok");
