import { describe, expect, it } from "vitest";
import { synchronizationFailureMessage } from "./syncStatus";

describe("synchronization status", () => {
  it("only reports offline when connectivity is known to be unavailable", () => {
    expect(
      synchronizationFailureMessage("en", {
        isConnected: false,
        isInternetReachable: null,
      }),
    ).toContain("offline");
    expect(
      synchronizationFailureMessage("en", {
        isConnected: true,
        isInternetReachable: true,
      }),
    ).toContain("couldn't sync");
    expect(
      synchronizationFailureMessage("en", {
        isConnected: null,
        isInternetReachable: null,
      }),
    ).toContain("couldn't sync");
  });

  it("localizes both failure states", () => {
    expect(
      synchronizationFailureMessage("pt-BR", {
        isConnected: false,
        isInternetReachable: false,
      }),
    ).toContain("sem conexão");
    expect(
      synchronizationFailureMessage("pt-BR", {
        isConnected: true,
        isInternetReachable: true,
      }),
    ).toContain("Não foi possível sincronizar");
  });
});
