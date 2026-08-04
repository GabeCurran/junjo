import { Junjo } from "@junjo-io/sdk";
import { render, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { JunjoProvider } from "./JunjoProvider.js";
import { useJunjo } from "./useJunjo.js";

function makeClient(): Junjo {
  return new Junjo({
    apiKey: "test_prefix.test_secret",
    fetch: vi.fn() as unknown as typeof fetch,
  });
}

describe("JunjoProvider + useJunjo", () => {
  it("returns the Junjo instance passed via the client prop", () => {
    const client = makeClient();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <JunjoProvider client={client}>{children}</JunjoProvider>
    );

    const { result } = renderHook(() => useJunjo(), { wrapper });

    expect(result.current).toBe(client);
  });

  it("returns the same instance across nested consumers", () => {
    const client = makeClient();
    let nestedSeen: Junjo | null = null;

    function Inner() {
      nestedSeen = useJunjo();
      return null;
    }

    function Outer() {
      const top = useJunjo();
      expect(top).toBe(client);
      return <Inner />;
    }

    render(
      <JunjoProvider client={client}>
        <Outer />
      </JunjoProvider>,
    );

    expect(nestedSeen).toBe(client);
  });

  it("throws a descriptive error when used outside a JunjoProvider", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(() => renderHook(() => useJunjo())).toThrow(
        /useJunjo must be used inside a <JunjoProvider>/,
      );
    } finally {
      consoleError.mockRestore();
    }
  });

  it("re-renders consumers when the client prop changes", () => {
    const first = makeClient();
    const second = makeClient();
    let seen: Junjo | null = null;

    function Consumer() {
      seen = useJunjo();
      return null;
    }

    const { rerender } = render(
      <JunjoProvider client={first}>
        <Consumer />
      </JunjoProvider>,
    );
    expect(seen).toBe(first);

    rerender(
      <JunjoProvider client={second}>
        <Consumer />
      </JunjoProvider>,
    );
    expect(seen).toBe(second);
  });

  it("scopes nested providers: inner provider wins inside its subtree", () => {
    const outer = makeClient();
    const inner = makeClient();
    let outerSeen: Junjo | null = null;
    let innerSeen: Junjo | null = null;

    function OuterConsumer() {
      outerSeen = useJunjo();
      return null;
    }

    function InnerConsumer() {
      innerSeen = useJunjo();
      return null;
    }

    render(
      <JunjoProvider client={outer}>
        <OuterConsumer />
        <JunjoProvider client={inner}>
          <InnerConsumer />
        </JunjoProvider>
      </JunjoProvider>,
    );

    expect(outerSeen).toBe(outer);
    expect(innerSeen).toBe(inner);
  });

  it("renders children verbatim", () => {
    const client = makeClient();
    const { container } = render(
      <JunjoProvider client={client}>
        <span data-testid="child">hello</span>
      </JunjoProvider>,
    );
    expect(container.querySelector('[data-testid="child"]')?.textContent).toBe("hello");
  });
});
