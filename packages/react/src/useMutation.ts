import { type Reducer, useCallback, useEffect, useReducer, useRef } from "react";

export type MutationStatus = "idle" | "pending" | "success" | "error";

export interface UseMutationOptions<TData, TError = Error, TVariables = void, TContext = unknown> {
  mutationFn: (variables: TVariables) => Promise<TData>;
  onMutate?: (variables: TVariables) => TContext | Promise<TContext> | void | Promise<void>;
  onSuccess?: (
    data: TData,
    variables: TVariables,
    context: TContext | undefined,
  ) => void | Promise<void>;
  onError?: (
    error: TError,
    variables: TVariables,
    context: TContext | undefined,
  ) => void | Promise<void>;
  onSettled?: (
    data: TData | undefined,
    error: TError | null,
    variables: TVariables,
    context: TContext | undefined,
  ) => void | Promise<void>;
}

export interface UseMutationResult<TData, TError = Error, TVariables = void> {
  mutate: (variables: TVariables) => void;
  mutateAsync: (variables: TVariables) => Promise<TData>;
  status: MutationStatus;
  data: TData | undefined;
  error: TError | null;
  isIdle: boolean;
  isPending: boolean;
  isSuccess: boolean;
  isError: boolean;
  reset: () => void;
}

interface State<TData, TError> {
  status: MutationStatus;
  data: TData | undefined;
  error: TError | null;
}

type Action<TData, TError> =
  | { type: "pending" }
  | { type: "success"; data: TData }
  | { type: "error"; error: TError }
  | { type: "reset" };

function makeReducer<TData, TError>(): Reducer<State<TData, TError>, Action<TData, TError>> {
  return (state, action) => {
    switch (action.type) {
      case "pending":
        return { status: "pending", data: undefined, error: null };
      case "success":
        return { status: "success", data: action.data, error: null };
      case "error":
        return { status: "error", data: undefined, error: action.error };
      case "reset":
        return { status: "idle", data: undefined, error: null };
      default:
        return state;
    }
  };
}

const initialState = <TData, TError>(): State<TData, TError> => ({
  status: "idle",
  data: undefined,
  error: null,
});

async function safeCall<T>(callback: (() => Promise<T> | T) | undefined): Promise<unknown> {
  if (callback === undefined) return undefined;
  try {
    await callback();
    return undefined;
  } catch (err) {
    return err;
  }
}

export function useMutation<TData, TError = Error, TVariables = void, TContext = unknown>(
  options: UseMutationOptions<TData, TError, TVariables, TContext>,
): UseMutationResult<TData, TError, TVariables> {
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const [state, dispatch] = useReducer(
    makeReducer<TData, TError>(),
    undefined,
    initialState<TData, TError>,
  );

  const generationRef = useRef(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const mutateAsync = useCallback(async (variables: TVariables): Promise<TData> => {
    const generation = ++generationRef.current;
    const opts = optionsRef.current;
    const isLatest = () => generation === generationRef.current && mountedRef.current;
    if (isLatest()) dispatch({ type: "pending" });

    let context: TContext | undefined;
    try {
      const result = await opts.onMutate?.(variables);
      context = (result ?? undefined) as TContext | undefined;
    } catch (err) {
      const error = err as TError;
      if (isLatest()) dispatch({ type: "error", error });
      await safeCall(() => opts.onError?.(error, variables, context));
      await safeCall(() => opts.onSettled?.(undefined, error, variables, context));
      throw err;
    }

    let data: TData;
    try {
      data = await opts.mutationFn(variables);
    } catch (err) {
      const error = err as TError;
      if (isLatest()) dispatch({ type: "error", error });
      await safeCall(() => opts.onError?.(error, variables, context));
      await safeCall(() => opts.onSettled?.(undefined, error, variables, context));
      throw err;
    }

    if (isLatest()) dispatch({ type: "success", data });
    const successErr = await safeCall(() => opts.onSuccess?.(data, variables, context));
    const settledErr = await safeCall(() => opts.onSettled?.(data, null, variables, context));
    if (successErr !== undefined) throw successErr;
    if (settledErr !== undefined) throw settledErr;
    return data;
  }, []);

  const mutate = useCallback(
    (variables: TVariables): void => {
      mutateAsync(variables).catch(() => {});
    },
    [mutateAsync],
  );

  const reset = useCallback(() => {
    generationRef.current++;
    dispatch({ type: "reset" });
  }, []);

  return {
    mutate,
    mutateAsync,
    status: state.status,
    data: state.data,
    error: state.error,
    isIdle: state.status === "idle",
    isPending: state.status === "pending",
    isSuccess: state.status === "success",
    isError: state.status === "error",
    reset,
  };
}
