"use client";

import type { ButtonHTMLAttributes, MouseEvent } from "react";

interface Props extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onClick"> {
    /** Confirmation prompt shown via window.confirm before the action fires. */
    message: string;
}

/**
  * Submit button wrapped in a native window.confirm gate. Use inside a
  * server-action <form> for destructive operations (delete line, cancel
  * job, remove staff). Cancel → preventDefault, form does NOT submit.
  *
  * Native confirm() over a custom modal because:
  *  - Works identically on iPhone Safari + Android Chrome
  *  - Universally understood by users
  *  - Zero new surface area to keep accessible
  * If we ever want a styled modal, swap this component out and every
  * caller comes along.
  */
export function ConfirmButton({ message, children, ...rest }: Props) {
    const onClick = (e: MouseEvent<HTMLButtonElement>) => {
        if (!window.confirm(message)) {
            e.preventDefault();
        }
    };
    return (
        <button type="submit" {...rest} onClick={onClick}>
            {children}
        </button>
    );
}
