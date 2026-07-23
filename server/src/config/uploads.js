const path = require("path");

const defaultUploadsRoot = path.join(__dirname, "..", "..", "uploads");
const uploadsRoot = path.resolve(process.env.UPLOAD_ROOT || defaultUploadsRoot);
const raffleUploadsDir = path.join(uploadsRoot, "raffles");

module.exports = {
  uploadsRoot,
  raffleUploadsDir,
};
