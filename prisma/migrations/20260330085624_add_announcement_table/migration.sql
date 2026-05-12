-- CreateTable
CREATE TABLE "forum_announcements" (
    "id" SERIAL NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "forum_announcements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "forum_announcements_translations" (
    "id" SERIAL NOT NULL,
    "locale" "locales" NOT NULL,
    "title" VARCHAR(255) NOT NULL,
    "description" TEXT NOT NULL,
    "tags" JSONB,
    "forum_announcements_id" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "forum_announcements_translations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "unique_forum_announcements_id_locale" ON "forum_announcements_translations"("title", "description", "forum_announcements_id", "locale");

-- AddForeignKey
ALTER TABLE "forum_announcements_translations" ADD CONSTRAINT "forum_announcements_translations_forum_announcements_id_fkey" FOREIGN KEY ("forum_announcements_id") REFERENCES "forum_announcements"("id") ON DELETE CASCADE ON UPDATE CASCADE;
