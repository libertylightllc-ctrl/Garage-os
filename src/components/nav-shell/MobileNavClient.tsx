"use client";

import { useState } from "react";
import { BottomTabBar, type BottomTab } from "./BottomTabBar";
import { MoreSheet, type MoreSheetItem } from "./MoreSheet";

/**
 * Client wrapper — owns the open/close state of the "More" bottom
 * sheet and wires BottomTabBar's More button to it. Rendered by the
 * server AppShell so we don't need every consumer page to remember to
 * put the sheet in the tree.
 */
export function MobileNavClient({
    tabs,
    activeKey,
    moreItems,
    moreLabel,
    settingsLabel,
    signOutLabel,
    hasOverflowBadge,
}: {
    tabs: BottomTab[];
    activeKey?: string;
    moreItems: MoreSheetItem[];
    moreLabel: string;
    settingsLabel: string;
    signOutLabel: string;
    hasOverflowBadge: boolean;
}) {
    const [open, setOpen] = useState(false);
    const showMoreButton = moreItems.length > 0;

    return (
        <>
            <BottomTabBar
                tabs={tabs}
                activeKey={activeKey}
                moreLabel={showMoreButton ? moreLabel : undefined}
                onMoreClick={showMoreButton ? () => setOpen(true) : undefined}
                hasOverflowBadge={hasOverflowBadge}
            />
            <MoreSheet
                open={open}
                onClose={() => setOpen(false)}
                items={moreItems}
                settingsLabel={settingsLabel}
                signOutLabel={signOutLabel}
                activeKey={activeKey}
            />
        </>
    );
}
