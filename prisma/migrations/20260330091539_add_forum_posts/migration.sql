-- CreateTable
CREATE TABLE "forum_posts" (
    "id" SERIAL NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "category" VARCHAR(50) NOT NULL,
    "author_name" VARCHAR(255) NOT NULL DEFAULT 'Forum Team',
    "title" VARCHAR(255) NOT NULL,
    "content" TEXT NOT NULL,
    "tags" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "forum_posts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "forum_posts_category_idx" ON "forum_posts"("category");
