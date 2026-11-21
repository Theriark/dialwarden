const none = (): string[] => [];

export const gate = new EntitlementGate(() => entitlement(true), none);
