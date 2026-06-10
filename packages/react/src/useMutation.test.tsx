import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useMutation } from "./useMutation.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useMutation", () => {
  it("starts in the idle state", () => {
    const { result } = renderHook(() =>
      useMutation<string, Error, void>({
        mutationFn: vi.fn().mockResolvedValue("ok"),
      }),
    );

    expect(result.current.status).toBe("idle");
    expect(result.current.isIdle).toBe(true);
    expect(result.current.isPending).toBe(false);
    expect(result.current.isSuccess).toBe(false);
    expect(result.current.isError).toBe(false);
    expect(result.current.data).toBeUndefined();
    expect(result.current.error).toBeNull();
  });

  it("transitions idle -> pending -> success on a successful mutate", async () => {
    let resolveMutation!: (data: string) => void;
    const mutationFn = vi.fn().mockReturnValue(
      new Promise<string>((r) => {
        resolveMutation = r;
      }),
    );

    const { result } = renderHook(() => useMutation<string, Error, number>({ mutationFn }));

    act(() => {
      result.current.mutate(7);
    });
    expect(result.current.status).toBe("pending");
    expect(result.current.isPending).toBe(true);

    await act(async () => {
      resolveMutation("ok");
      await Promise.resolve();
    });

    expect(result.current.status).toBe("success");
    expect(result.current.isSuccess).toBe(true);
    expect(result.current.data).toBe("ok");
    expect(result.current.error).toBeNull();
    expect(mutationFn).toHaveBeenCalledWith(7);
    expect(mutationFn).toHaveBeenCalledTimes(1);
  });

  it("transitions idle -> pending -> error when the mutationFn rejects", async () => {
    const error = new Error("boom");
    const mutationFn = vi.fn().mockRejectedValue(error);

    const { result } = renderHook(() => useMutation<string, Error, void>({ mutationFn }));

    await act(async () => {
      await result.current.mutateAsync().catch(() => {});
    });

    expect(result.current.status).toBe("error");
    expect(result.current.isError).toBe(true);
    expect(result.current.error).toBe(error);
    expect(result.current.data).toBeUndefined();
  });

  it("mutate() is fire-and-forget and never rejects on error", async () => {
    const error = new Error("boom");
    const mutationFn = vi.fn().mockRejectedValue(error);
    const unhandled = vi.fn();
    const handler = (e: PromiseRejectionEvent) => unhandled(e.reason);
    if (typeof window !== "undefined") {
      window.addEventListener("unhandledrejection", handler);
    }

    const { result } = renderHook(() => useMutation<string, Error, void>({ mutationFn }));

    await act(async () => {
      result.current.mutate();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.error).toBe(error);
    expect(unhandled).not.toHaveBeenCalled();
    if (typeof window !== "undefined") {
      window.removeEventListener("unhandledrejection", handler);
    }
  });

  it("mutateAsync() resolves with the data on success", async () => {
    const mutationFn = vi.fn().mockResolvedValue({ id: "abc" });
    const { result } = renderHook(() => useMutation<{ id: string }, Error, number>({ mutationFn }));

    let resolved: { id: string } | undefined;
    await act(async () => {
      resolved = await result.current.mutateAsync(1);
    });

    expect(resolved).toEqual({ id: "abc" });
    expect(result.current.data).toEqual({ id: "abc" });
  });

  it("mutateAsync() rejects with the error on failure", async () => {
    const error = new Error("nope");
    const mutationFn = vi.fn().mockRejectedValue(error);
    const { result } = renderHook(() => useMutation<string, Error, void>({ mutationFn }));

    let caught: unknown;
    await act(async () => {
      try {
        await result.current.mutateAsync();
      } catch (e) {
        caught = e;
      }
    });

    expect(caught).toBe(error);
    expect(result.current.status).toBe("error");
    expect(result.current.error).toBe(error);
  });

  it("invokes onMutate before mutationFn with the same variables", async () => {
    const order: string[] = [];
    const onMutate = vi.fn((vars: number) => {
      order.push(`onMutate:${vars}`);
    });
    const mutationFn = vi.fn().mockImplementation(async (vars: number) => {
      order.push(`mutationFn:${vars}`);
      return vars * 2;
    });

    const { result } = renderHook(() =>
      useMutation<number, Error, number>({ mutationFn, onMutate }),
    );

    await act(async () => {
      await result.current.mutateAsync(5);
    });

    expect(order).toEqual(["onMutate:5", "mutationFn:5"]);
    expect(onMutate).toHaveBeenCalledWith(5);
  });

  it("threads the onMutate return value to onError as the rollback context", async () => {
    const error = new Error("rollback me");
    const onMutate = vi.fn().mockReturnValue({ snapshot: [1, 2, 3] });
    const onError = vi.fn();
    const mutationFn = vi.fn().mockRejectedValue(error);

    const { result } = renderHook(() =>
      useMutation<string, Error, string, { snapshot: number[] }>({
        mutationFn,
        onMutate,
        onError,
      }),
    );

    await act(async () => {
      await result.current.mutateAsync("vars").catch(() => {});
    });

    expect(onError).toHaveBeenCalledWith(error, "vars", { snapshot: [1, 2, 3] });
  });

  it("threads the onMutate return value to onSuccess as the context", async () => {
    const onMutate = vi.fn().mockReturnValue({ optimistic: "applied" });
    const onSuccess = vi.fn();
    const mutationFn = vi.fn().mockResolvedValue("done");

    const { result } = renderHook(() =>
      useMutation<string, Error, string, { optimistic: string }>({
        mutationFn,
        onMutate,
        onSuccess,
      }),
    );

    await act(async () => {
      await result.current.mutateAsync("vars");
    });

    expect(onSuccess).toHaveBeenCalledWith("done", "vars", { optimistic: "applied" });
  });

  it("calls onSettled with (data, null, variables, context) on success", async () => {
    const onMutate = vi.fn().mockReturnValue("ctx");
    const onSettled = vi.fn();
    const mutationFn = vi.fn().mockResolvedValue("data");

    const { result } = renderHook(() =>
      useMutation<string, Error, number, string>({ mutationFn, onMutate, onSettled }),
    );

    await act(async () => {
      await result.current.mutateAsync(42);
    });

    expect(onSettled).toHaveBeenCalledWith("data", null, 42, "ctx");
  });

  it("calls onSettled with (undefined, error, variables, context) on failure", async () => {
    const error = new Error("err");
    const onMutate = vi.fn().mockReturnValue("ctx");
    const onSettled = vi.fn();
    const mutationFn = vi.fn().mockRejectedValue(error);

    const { result } = renderHook(() =>
      useMutation<string, Error, number, string>({ mutationFn, onMutate, onSettled }),
    );

    await act(async () => {
      await result.current.mutateAsync(99).catch(() => {});
    });

    expect(onSettled).toHaveBeenCalledWith(undefined, error, 99, "ctx");
  });

  it("awaits an async onMutate before calling mutationFn", async () => {
    const order: string[] = [];
    let resolveOnMutate!: () => void;
    const onMutate = vi.fn(
      () =>
        new Promise<string>((r) => {
          resolveOnMutate = () => {
            order.push("onMutate-resolved");
            r("ctx");
          };
        }),
    );
    const mutationFn = vi.fn().mockImplementation(async () => {
      order.push("mutationFn-called");
      return "ok";
    });

    const { result } = renderHook(() =>
      useMutation<string, Error, void, string>({ mutationFn, onMutate }),
    );

    let mutatePromise!: Promise<string>;
    act(() => {
      mutatePromise = result.current.mutateAsync();
    });
    await Promise.resolve();
    expect(mutationFn).not.toHaveBeenCalled();

    await act(async () => {
      resolveOnMutate();
      await mutatePromise;
    });

    expect(order).toEqual(["onMutate-resolved", "mutationFn-called"]);
  });

  it("treats a thrown onMutate as a mutation error and skips mutationFn", async () => {
    const onMutateError = new Error("setup failed");
    const onMutate = vi.fn().mockRejectedValue(onMutateError);
    const mutationFn = vi.fn();
    const onError = vi.fn();
    const onSettled = vi.fn();

    const { result } = renderHook(() =>
      useMutation<string, Error, number, string>({
        mutationFn,
        onMutate,
        onError,
        onSettled,
      }),
    );

    let caught: unknown;
    await act(async () => {
      try {
        await result.current.mutateAsync(1);
      } catch (e) {
        caught = e;
      }
    });

    expect(caught).toBe(onMutateError);
    expect(mutationFn).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(onMutateError, 1, undefined);
    expect(onSettled).toHaveBeenCalledWith(undefined, onMutateError, 1, undefined);
    expect(result.current.status).toBe("error");
    expect(result.current.error).toBe(onMutateError);
  });

  it("reset() returns the hook to idle and clears data/error", async () => {
    const mutationFn = vi.fn().mockResolvedValue("v");
    const { result } = renderHook(() => useMutation<string, Error, void>({ mutationFn }));

    await act(async () => {
      await result.current.mutateAsync();
    });
    expect(result.current.status).toBe("success");

    act(() => {
      result.current.reset();
    });

    expect(result.current.status).toBe("idle");
    expect(result.current.isIdle).toBe(true);
    expect(result.current.data).toBeUndefined();
    expect(result.current.error).toBeNull();
  });

  it("reflects only the latest mutate's status when called rapidly, but fires every callback", async () => {
    const resolves: Array<(s: string) => void> = [];
    const mutationFn = vi.fn(
      (vars: string) =>
        new Promise<string>((r) => {
          resolves.push((s) => r(`${vars}-${s}`));
        }),
    );
    const onMutate = vi.fn();
    const onSuccess = vi.fn();
    const onSettled = vi.fn();

    const { result } = renderHook(() =>
      useMutation<string, Error, string>({ mutationFn, onMutate, onSuccess, onSettled }),
    );

    await act(async () => {
      result.current.mutate("a");
      result.current.mutate("b");
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(onMutate).toHaveBeenCalledTimes(2);
    expect(onMutate).toHaveBeenNthCalledWith(1, "a");
    expect(onMutate).toHaveBeenNthCalledWith(2, "b");
    expect(resolves.length).toBe(2);

    await act(async () => {
      resolves[0]?.("done");
      resolves[1]?.("done");
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(onSuccess).toHaveBeenCalledTimes(2);
    expect(onSettled).toHaveBeenCalledTimes(2);
    expect(result.current.status).toBe("success");
    expect(result.current.data).toBe("b-done");
  });

  it("recovers from error -> pending -> success on a subsequent mutate", async () => {
    const mutationFn = vi
      .fn()
      .mockRejectedValueOnce(new Error("first"))
      .mockResolvedValueOnce("ok");

    const { result } = renderHook(() => useMutation<string, Error, void>({ mutationFn }));

    await act(async () => {
      await result.current.mutateAsync().catch(() => {});
    });
    expect(result.current.status).toBe("error");

    await act(async () => {
      await result.current.mutateAsync();
    });
    expect(result.current.status).toBe("success");
    expect(result.current.data).toBe("ok");
    expect(result.current.error).toBeNull();
  });

  it("uses the latest options closure on each mutate call", async () => {
    const mutationFn = vi.fn().mockResolvedValue("ok");
    const onSuccessA = vi.fn();
    const onSuccessB = vi.fn();

    const { result, rerender } = renderHook(
      ({ onSuccess }: { onSuccess: () => void }) =>
        useMutation<string, Error, void>({ mutationFn, onSuccess }),
      { initialProps: { onSuccess: onSuccessA } },
    );

    await act(async () => {
      await result.current.mutateAsync();
    });
    expect(onSuccessA).toHaveBeenCalledTimes(1);
    expect(onSuccessB).not.toHaveBeenCalled();

    rerender({ onSuccess: onSuccessB });

    await act(async () => {
      await result.current.mutateAsync();
    });
    expect(onSuccessA).toHaveBeenCalledTimes(1);
    expect(onSuccessB).toHaveBeenCalledTimes(1);
  });

  it("propagates errors thrown inside onSuccess from mutateAsync", async () => {
    const handlerError = new Error("from-onSuccess");
    const onSuccess = vi.fn().mockRejectedValue(handlerError);
    const mutationFn = vi.fn().mockResolvedValue("ok");

    const { result } = renderHook(() =>
      useMutation<string, Error, void>({ mutationFn, onSuccess }),
    );

    let caught: unknown;
    await act(async () => {
      try {
        await result.current.mutateAsync();
      } catch (e) {
        caught = e;
      }
    });

    expect(caught).toBe(handlerError);
    expect(result.current.status).toBe("success");
    expect(result.current.data).toBe("ok");
  });

  it("an onError callback that throws does not prevent status from reaching error", async () => {
    const mutationError = new Error("boom");
    const onError = vi.fn().mockRejectedValue(new Error("from-onError"));
    const onSettled = vi.fn();
    const mutationFn = vi.fn().mockRejectedValue(mutationError);

    const { result } = renderHook(() =>
      useMutation<string, Error, void>({ mutationFn, onError, onSettled }),
    );

    let caught: unknown;
    await act(async () => {
      try {
        await result.current.mutateAsync();
      } catch (e) {
        caught = e;
      }
    });

    expect(caught).toBe(mutationError);
    expect(result.current.status).toBe("error");
    expect(result.current.error).toBe(mutationError);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onSettled).toHaveBeenCalledWith(undefined, mutationError, undefined, undefined);
  });

  it("calls onSettled even if onSuccess throws", async () => {
    const handlerError = new Error("from-onSuccess");
    const onSuccess = vi.fn().mockRejectedValue(handlerError);
    const onSettled = vi.fn();
    const mutationFn = vi.fn().mockResolvedValue("ok");

    const { result } = renderHook(() =>
      useMutation<string, Error, void>({ mutationFn, onSuccess, onSettled }),
    );

    await act(async () => {
      await result.current.mutateAsync().catch(() => {});
    });

    expect(onSettled).toHaveBeenCalledWith("ok", null, undefined, undefined);
  });

  it("fires callbacks but skips state updates when the component has unmounted", async () => {
    let resolveMutation!: (data: string) => void;
    const promise = new Promise<string>((r) => {
      resolveMutation = r;
    });
    const mutationFn = vi.fn().mockReturnValue(promise);
    const onSuccess = vi.fn();
    const onSettled = vi.fn();

    const { result, unmount } = renderHook(() =>
      useMutation<string, Error, void>({ mutationFn, onSuccess, onSettled }),
    );

    let mutatePromise!: Promise<string>;
    await act(async () => {
      mutatePromise = result.current.mutateAsync();
      await Promise.resolve();
    });
    expect(result.current.status).toBe("pending");
    expect(mutationFn).toHaveBeenCalledTimes(1);

    unmount();
    await act(async () => {
      resolveMutation("late");
      await mutatePromise;
    });

    expect(onSuccess).toHaveBeenCalledWith("late", undefined, undefined);
    expect(onSettled).toHaveBeenCalledWith("late", null, undefined, undefined);
  });

  it("snapshots options at call time so a re-render mid-flight does not change the in-flight onSuccess", async () => {
    let resolveMutation!: (data: string) => void;
    const promise = new Promise<string>((r) => {
      resolveMutation = r;
    });
    const mutationFn = vi.fn().mockReturnValue(promise);
    const onSuccessA = vi.fn();
    const onSuccessB = vi.fn();

    const { result, rerender } = renderHook(
      ({ onSuccess }: { onSuccess: () => void }) =>
        useMutation<string, Error, void>({ mutationFn, onSuccess }),
      { initialProps: { onSuccess: onSuccessA } },
    );

    let mutatePromise!: Promise<string>;
    await act(async () => {
      mutatePromise = result.current.mutateAsync();
      await Promise.resolve();
    });

    rerender({ onSuccess: onSuccessB });

    await act(async () => {
      resolveMutation("done");
      await mutatePromise;
    });

    expect(onSuccessA).toHaveBeenCalledTimes(1);
    expect(onSuccessB).not.toHaveBeenCalled();
  });

  it("reset() during an in-flight mutation cancels its state effect but lets callbacks complete", async () => {
    let resolveMutation!: (data: string) => void;
    const promise = new Promise<string>((r) => {
      resolveMutation = r;
    });
    const mutationFn = vi.fn().mockReturnValue(promise);
    const onSuccess = vi.fn();

    const { result } = renderHook(() =>
      useMutation<string, Error, void>({ mutationFn, onSuccess }),
    );

    let mutatePromise!: Promise<string>;
    await act(async () => {
      mutatePromise = result.current.mutateAsync();
      await Promise.resolve();
    });
    expect(result.current.status).toBe("pending");

    act(() => {
      result.current.reset();
    });
    expect(result.current.status).toBe("idle");

    await act(async () => {
      resolveMutation("late");
      await mutatePromise;
    });

    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(result.current.status).toBe("idle");
    expect(result.current.data).toBeUndefined();
  });
});
