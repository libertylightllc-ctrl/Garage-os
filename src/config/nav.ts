/**
 * Nav configuration — single source of truth for what appears in the
 * mobile bottom bar (primary) vs the "More" sheet (overflow) vs the
 * desktop side nav (both, grouped).
 *
 * Each role's nav is split into `primary` (~4-5 items) that live in the
 * bottom tab bar on mobile, and `overflow` (the rest) that live in the
 * "More" bottom sheet. Desktop shows all items in the left side nav.
 *
 * Legacy `NAV_LEGACY` re-exports the existing flat shape so app-nav.tsx
 * can keep rendering the old scrolling strip until each role is
 * migrated to the new AppShell (see docs on slice plan).
 */
import type { LucideIcon } from "lucide-react";
import {
  LayoutDashboard,
  ClipboardList,
  FilePlus,
  Wrench,
  Calculator,
  CreditCard,
  Car,
  Calendar,
  Package,
  Bell,
  MessageCircle,
  MessageSquare,
  Building2,
  Warehouse,
  Users,
  Clock,
  Boxes,
  Truck,
  ShoppingCart,
  Receipt,
  BookOpen,
  BarChart3,
} from "lucide-react";
import type { StaffRole } from "@/lib/roles";
import type { MessageKey } from "@/i18n/config";

export interface NavItem {
  key: string;
  href: string;
  labelKey: MessageKey;
  icon: LucideIcon;
  /** Which counter to badge with (advisor + master only): chats/parts/reminders. */
  badge?: "needsHuman" | "openParts" | "dueReminders";
}

export interface RoleNav {
  /** ~4-5 items — shown inline in the mobile bottom tab bar. */
  primary: NavItem[];
  /** Everything else — shown in the "More" bottom sheet on mobile. */
  overflow: NavItem[];
}

export const NAV: Record<StaffRole, RoleNav> = {
  OWNER: {
    primary: [
      { key: "dashboard", href: "/owner", labelKey: "tabDashboard", icon: LayoutDashboard },
      { key: "jobs", href: "/advisor", labelKey: "tabJobs", icon: ClipboardList },
      { key: "intake", href: "/advisor/jobs/new", labelKey: "tabIntake", icon: FilePlus },
      { key: "inventory", href: "/owner/inventory", labelKey: "tabInventory", icon: Boxes },
      { key: "analytics", href: "/owner/analytics", labelKey: "tabAnalytics", icon: BarChart3 },
    ],
    overflow: [
      { key: "branches", href: "/owner/branches", labelKey: "tabBranches", icon: Building2 },
      { key: "bays", href: "/owner/bays", labelKey: "tabBays", icon: Warehouse },
      { key: "team", href: "/owner/staff", labelKey: "tabTeam", icon: Users },
      { key: "hours", href: "/owner/hours", labelKey: "tabHours", icon: Clock },
      { key: "suppliers", href: "/owner/suppliers", labelKey: "tabSuppliers", icon: Truck },
      { key: "purchasing", href: "/owner/purchasing", labelKey: "tabPurchasing", icon: ShoppingCart },
      { key: "billing", href: "/owner/billing", labelKey: "tabBilling", icon: Receipt },
      { key: "ledger", href: "/owner/ledger", labelKey: "tabLedger", icon: BookOpen },
      { key: "whatsapp", href: "/owner/whatsapp", labelKey: "tabWhatsapp", icon: MessageSquare },
    ],
  },
  ADVISOR: {
    primary: [
      { key: "jobs", href: "/advisor", labelKey: "tabJobs", icon: ClipboardList },
      { key: "estimates", href: "/advisor/estimates", labelKey: "tabEstimates", icon: Calculator },
      { key: "chats", href: "/advisor/chats", labelKey: "tabChats", icon: MessageCircle, badge: "needsHuman" },
      { key: "parts", href: "/advisor/parts", labelKey: "tabParts", icon: Package, badge: "openParts" },
      { key: "bookings", href: "/advisor/bookings", labelKey: "tabBookings", icon: Calendar },
    ],
    overflow: [
      { key: "vehicles", href: "/advisor/vehicles", labelKey: "tabVehicles", icon: Car },
      { key: "reminders", href: "/advisor/reminders", labelKey: "tabReminders", icon: Bell, badge: "dueReminders" },
      { key: "whatsapp", href: "/advisor/whatsapp", labelKey: "tabWhatsapp", icon: MessageSquare },
    ],
  },
  TECH: {
    primary: [
      { key: "workshop", href: "/technician", labelKey: "tabWorkshop", icon: Wrench },
    ],
    overflow: [],
  },
  CASHIER: {
    primary: [
      { key: "accounts", href: "/cashier", labelKey: "tabAccounts", icon: CreditCard },
      { key: "whatsapp", href: "/cashier/whatsapp", labelKey: "tabWhatsapp", icon: MessageSquare },
    ],
    overflow: [],
  },
  // MASTER runs the whole floor. The primary five are the full
  // intake → workshop → estimate → payment journey. Everything else
  // (lookups, comms, reports) is overflow. Deliberately NO owner-only
  // tabs (dashboard/billing/ledger/analytics stay owner-only).
  MASTER: {
    primary: [
      { key: "jobs", href: "/advisor", labelKey: "tabJobs", icon: ClipboardList },
      { key: "intake", href: "/advisor/jobs/new", labelKey: "tabIntake", icon: FilePlus },
      { key: "workshop", href: "/technician", labelKey: "tabWorkshop", icon: Wrench },
      { key: "estimates", href: "/advisor/estimates", labelKey: "tabEstimates", icon: Calculator },
      { key: "accounts", href: "/cashier", labelKey: "tabAccounts", icon: CreditCard },
    ],
    overflow: [
      { key: "vehicles", href: "/advisor/vehicles", labelKey: "tabVehicles", icon: Car },
      { key: "bookings", href: "/advisor/bookings", labelKey: "tabBookings", icon: Calendar },
      { key: "parts", href: "/advisor/parts", labelKey: "tabParts", icon: Package, badge: "openParts" },
      { key: "reminders", href: "/advisor/reminders", labelKey: "tabReminders", icon: Bell, badge: "dueReminders" },
      { key: "chats", href: "/advisor/chats", labelKey: "tabChats", icon: MessageCircle, badge: "needsHuman" },
      { key: "hours", href: "/owner/hours", labelKey: "tabHours", icon: Clock },
      { key: "whatsapp", href: "/advisor/whatsapp", labelKey: "tabWhatsapp", icon: MessageSquare },
    ],
  },
};

/** Every nav item (primary + overflow) for a role, in display order. */
export function allNavItems(role: StaffRole): NavItem[] {
  const r = NAV[role];
  return [...r.primary, ...r.overflow];
}
