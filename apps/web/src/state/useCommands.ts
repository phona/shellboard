import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
} from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import type { Command, CreateCommandInput, UpdateCommandInput } from "@shellboard/contracts";
import { api, ApiError } from "../api/client";
import { toast } from "./toasts";
import {
  discardLocalPresets,
  planMigration,
  readLocalPresets,
} from "./commandsMigration";

export const COMMANDS_QUERY_KEY = ["commands"] as const;

/**
 * Registered launch commands (D9). Server-side since the presets carry
 * environment variables that must survive a browser change; the query is
 * shared by the settings registry and the new-session dialog.
 */
export function useCommands() {
  return useQuery({ queryKey: COMMANDS_QUERY_KEY, queryFn: api.commands.list });
}

function useInvalidateCommands(): () => Promise<void> {
  const queryClient = useQueryClient();
  return async () => {
    await queryClient.invalidateQueries({ queryKey: COMMANDS_QUERY_KEY });
  };
}

export function useCreateCommand(): UseMutationResult<Command, Error, CreateCommandInput> {
  const invalidate = useInvalidateCommands();
  return useMutation({
    mutationFn: (input: CreateCommandInput) => api.commands.create(input),
    onSuccess: () => void invalidate(),
  });
}

export function useUpdateCommand(): UseMutationResult<Command, Error, UpdateCommandInput & { id: string }> {
  const invalidate = useInvalidateCommands();
  return useMutation({
    mutationFn: ({ id, ...input }) => api.commands.update(id, input),
    onSuccess: () => void invalidate(),
  });
}

export function useRemoveCommand(): UseMutationResult<{ ok: boolean }, Error, string> {
  const invalidate = useInvalidateCommands();
  return useMutation({
    mutationFn: (id: string) => api.commands.remove(id),
    onSuccess: () => void invalidate(),
    // No form to report into, so the failure surfaces as a toast (the row stays
    // until the next successful list).
    onError: (err) =>
      toast(err instanceof ApiError ? err.message : "remove failed", "error"),
  });
}

/**
 * Imports the pre-D9 browser-local presets once, on the first successful fetch
 * of the server list. Runs from App (not from the settings popover) so the
 * import does not depend on the user opening Settings.
 */
export function useCommandMigration(): void {
  const query = useQuery({ queryKey: COMMANDS_QUERY_KEY, queryFn: api.commands.list });
  const create = useCreateCommand();
  const attempted = useRef(false);

  useEffect(() => {
    if (attempted.current) return;
    const remote = query.data;
    if (!remote) return;
    attempted.current = true;

    const pending = planMigration(remote, readLocalPresets());
    if (pending.length === 0) {
      // Nothing to import (fresh install, or already imported): drop the
      // leftover key so it cannot be replayed later.
      discardLocalPresets();
      return;
    }
    void (async () => {
      for (const preset of pending) {
        try {
          await create.mutateAsync(preset);
        } catch {
          // Leave the local copy in place: the next page load retries.
          return;
        }
      }
      discardLocalPresets();
    })();
  }, [query.data, create]);
}
