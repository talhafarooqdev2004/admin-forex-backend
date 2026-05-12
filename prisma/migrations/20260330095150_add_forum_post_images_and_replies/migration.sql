-- AlterTable
ALTER TABLE "forum_posts" ADD COLUMN     "image_path" TEXT,
ADD COLUMN     "view_count" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "forum_post_replies" (
    "id" SERIAL NOT NULL,
    "forum_post_id" INTEGER NOT NULL,
    "author_name" VARCHAR(255) NOT NULL DEFAULT 'Forum Team',
    "message" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "forum_post_replies_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "forum_post_replies_forum_post_id_idx" ON "forum_post_replies"("forum_post_id");

-- AddForeignKey
ALTER TABLE "forum_post_replies" ADD CONSTRAINT "forum_post_replies_forum_post_id_fkey" FOREIGN KEY ("forum_post_id") REFERENCES "forum_posts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
