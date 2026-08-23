-- AR 2026-08-23. See src/lib/normalize.ts `normalizeCustomerPhoneForWrite`
-- for the write-time contract. Column is set true when the input
-- phone can't be resolved to an E.164 shape wa.me would accept; the
-- customer detail page surfaces the flag so an advisor can fix it.
ALTER TABLE "Customer" ADD COLUMN "phoneNeedsReview" BOOLEAN NOT NULL DEFAULT false;
