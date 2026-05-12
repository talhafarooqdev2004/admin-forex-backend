import fs from "fs";
import path from "path";
import multer from "multer";
import { ENV } from "../config/env.js";

const forumPostUploadDir = path.resolve(process.cwd(), ENV.UPLOAD_DIR, "forum-posts");

fs.mkdirSync(forumPostUploadDir, { recursive: true });

const storage = multer.diskStorage({
    destination: (_req, _file, callback) => {
        callback(null, forumPostUploadDir);
    },
    filename: (_req, file, callback) => {
        const extension = path.extname(file.originalname);
        const safeBaseName = path
            .basename(file.originalname, extension)
            .replace(/[^a-zA-Z0-9-_]/g, "-")
            .toLowerCase();

        callback(null, `${Date.now()}-${safeBaseName}${extension}`);
    },
});

export const forumPostImageUpload = multer({
    storage,
    limits: {
        fileSize: ENV.MAX_FILE_SIZE,
    },
    fileFilter: (_req, file, callback) => {
        if (!file.mimetype.startsWith("image/")) {
            callback(new Error("Only image uploads are allowed"));
            return;
        }

        callback(null, true);
    },
});
