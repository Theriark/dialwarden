export const entitlement = (paid: boolean): Entitlement =>
  resolveEntitlement({
    ui: null,
    env: paid
      ? {
          state: "active",
          payload: null,
          lidHash8: "abcdef01",
          last6: "xyz123",
          reason: null,
        }
      : null,
    envIgnored: false,
  });
