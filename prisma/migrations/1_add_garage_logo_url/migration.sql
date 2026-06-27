-- AlterTable
-- Add the per-garage logo URL field. Nullable + no default so every
-- existing Garage row stays valid (NULL = render the default GarageOS
-- brand). The field stores the permanent Supabase Storage public URL
-- returned by saveLogoUpload() in src/lib/storage.ts.
ALTER TABLE "Garage" ADD COLUMN "logoUrl" TEXT;
