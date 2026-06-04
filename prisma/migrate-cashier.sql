-- Rename the Role enum value ACCOUNTANT -> CASHIER in place (preserves existing rows).
ALTER TYPE "Role" RENAME VALUE 'ACCOUNTANT' TO 'CASHIER';
