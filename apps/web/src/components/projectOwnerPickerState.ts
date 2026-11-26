import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { create } from "zustand";

export interface ProjectOwnerPickerRequest {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly threadTitle: string;
  readonly resolve: () => void;
}

export const useProjectOwnerPickerRequest = create<{
  request: ProjectOwnerPickerRequest | null;
}>(() => ({
  request: null,
}));

export function requestProjectOwnerPicker(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly threadTitle: string;
}): Promise<void> {
  useProjectOwnerPickerRequest.getState().request?.resolve();
  return new Promise((resolve) =>
    useProjectOwnerPickerRequest.setState({ request: { ...input, resolve } }),
  );
}

export function closeProjectOwnerPicker() {
  const request = useProjectOwnerPickerRequest.getState().request;
  useProjectOwnerPickerRequest.setState({ request: null });
  request?.resolve();
}
