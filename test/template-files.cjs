"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");

// Discovery still walks real ancestor paths. Tests must not read host configs
// outside this repository; fixture paths keep the real filesystem implementation.
exports.isolateTemplateFiles = () => {
  const open = fs.open;
  const root = path.resolve(__dirname, "..");
  fs.open = async (file, ...args) => {
    const resolved = path.resolve(String(file));
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      throw Object.assign(new Error("Fixture path not found"), { code: "ENOENT" });
    }
    return open(file, ...args);
  };
};
