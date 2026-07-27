const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const sharp = require("sharp");

const MAX_INPUT_PIXELS = 40_000_000;
const WEBP_VARIANTS = [
  { width: 320, quality: 78 },
  { width: 768, quality: 82 },
  { width: 1280, quality: 84 },
];

function publicPath(filename) {
  return `/uploads/raffles/${filename}`;
}

async function removeFiles(files = []) {
  await Promise.all(files.map((file) => fs.promises.unlink(file).catch(() => undefined)));
}

async function optimizeRaffleImage(inputPath, outputDir, id = `${Date.now()}-${crypto.randomBytes(6).toString("hex")}`) {
  const files = [];
  const normalizedId = String(id).replace(/[^a-zA-Z0-9_-]/g, "");
  if (!normalizedId) throw Object.assign(new Error("Could not create an image filename."), { status: 400 });

  try {
    const source = sharp(inputPath, {
      failOn: "error",
      limitInputPixels: MAX_INPUT_PIXELS,
      animated: false,
    }).rotate();
    const metadata = await source.metadata();
    if (!metadata.width || !metadata.height || !["jpeg", "png", "webp", "gif"].includes(metadata.format)) {
      throw Object.assign(new Error("The uploaded file is not a supported image."), { status: 400 });
    }

    for (const variant of WEBP_VARIANTS) {
      const filename = `${normalizedId}-${variant.width}.webp`;
      const outputPath = path.join(outputDir, filename);
      await source.clone()
        .resize({ width: variant.width, withoutEnlargement: true })
        .webp({ quality: variant.quality, effort: 5, smartSubsample: true })
        .toFile(outputPath);
      files.push(outputPath);
    }

    const telegramFilename = `${normalizedId}-telegram.jpg`;
    const telegramPath = path.join(outputDir, telegramFilename);
    await source.clone()
      .flatten({ background: "#ffffff" })
      .resize({ width: 1280, withoutEnlargement: true })
      .jpeg({ quality: 84, progressive: true, mozjpeg: true })
      .toFile(telegramPath);
    files.push(telegramPath);

    return {
      url: publicPath(`${normalizedId}-1280.webp`),
      files,
      metadata: { width: metadata.width, height: metadata.height, format: metadata.format },
    };
  } catch (error) {
    await removeFiles(files);
    if (error.status) throw error;
    throw Object.assign(new Error("The uploaded image is corrupt or too large to process."), {
      status: 400,
      cause: error,
    });
  } finally {
    await fs.promises.unlink(inputPath).catch(() => undefined);
  }
}

function telegramCompanionPath(imageUrl, outputDir) {
  const filename = path.basename(String(imageUrl || ""));
  if (!/-1280\.webp$/i.test(filename)) return null;
  return path.join(outputDir, filename.replace(/-1280\.webp$/i, "-telegram.jpg"));
}

module.exports = {
  MAX_INPUT_PIXELS,
  WEBP_VARIANTS,
  optimizeRaffleImage,
  removeFiles,
  telegramCompanionPath,
};
