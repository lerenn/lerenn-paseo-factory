import { usePaseo } from "@getpaseo/plugin/client";
import { SettingsSelect } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { readField, writeField, type LaunchField } from "./yaml-fields";

const UNCHANGED = "";

/**
 * Dropdowns for the launch settings a role can force: provider, model, thinking level and
 * permission mode. They edit the role text in place (comments and the rest of the file are kept).
 * Models, thinking levels and modes come from the chosen provider, so the model, thinking and
 * mode pickers wait for a provider; a role that sets none leaves them to the person starting the agent.
 */
export function LaunchFields({ text, onChange }: { text: string; onChange(text: string): void }) {
  const paseo = usePaseo();
  const provider = readField(text, "provider");
  const model = readField(text, "model");
  const thinking = readField(text, "thinkingOptionId");
  const mode = readField(text, "modeId");

  const providers = useQuery({
    queryKey: ["agents-roles", "providers"],
    queryFn: async () => (await paseo.providers.listAvailable()).providers.filter((p) => p.available).map((p) => p.provider),
  });
  const models = useQuery({
    queryKey: ["agents-roles", "models", provider],
    queryFn: async () => (await paseo.providers.listModels(provider!)).models ?? [],
    enabled: Boolean(provider),
  });
  const modes = useQuery({
    queryKey: ["agents-roles", "modes", provider],
    queryFn: async () => (await paseo.providers.listModes(provider!)).modes ?? [],
    enabled: Boolean(provider),
  });

  const set = (field: LaunchField, value: string) => onChange(writeField(text, field, value || undefined));
  // Changing the provider invalidates the choices that depend on it.
  const setProvider = (value: string) => {
    let next = writeField(text, "provider", value || undefined);
    for (const field of ["model", "thinkingOptionId", "modeId"] as const) next = writeField(next, field, undefined);
    onChange(next);
  };
  const setModel = (value: string) => {
    const next = writeField(text, "model", value || undefined);
    onChange(writeField(next, "thinkingOptionId", undefined));
  };

  // Keep a value the lists do not know (a hand-written model id, say) selectable instead of hiding it.
  const withCurrent = (options: { label: string; value: string }[], current?: string) =>
    current && !options.some((o) => o.value === current) ? [...options, { label: `${current} (not listed)`, value: current }] : options;

  const chosenModel = models.data?.find((m) => m.id === model);
  return (
    <>
      <SettingsSelect
        label="Provider"
        hint="Forces the provider. Unchanged leaves the choice to whoever starts the agent."
        value={provider ?? UNCHANGED}
        options={withCurrent(
          [{ label: "Unchanged", value: UNCHANGED }, ...(providers.data ?? []).map((p) => ({ label: p, value: p }))],
          provider,
        )}
        onValueChange={setProvider}
      />
      {provider ? (
        <>
          <SettingsSelect
            label="Model"
            value={model ?? UNCHANGED}
            options={withCurrent(
              [{ label: "Unchanged", value: UNCHANGED }, ...(models.data ?? []).map((m) => ({ label: m.label, value: m.id }))],
              model,
            )}
            onValueChange={setModel}
          />
          <SettingsSelect
            label="Thinking level"
            hint={model && !chosenModel?.thinkingOptions?.length ? "This model has no thinking levels." : undefined}
            value={thinking ?? UNCHANGED}
            options={withCurrent(
              [{ label: "Unchanged", value: UNCHANGED }, ...(chosenModel?.thinkingOptions ?? []).map((t) => ({ label: t.label, value: t.id }))],
              thinking,
            )}
            onValueChange={(v) => set("thinkingOptionId", v)}
            disabled={!model}
          />
          <SettingsSelect
            label="Permission mode"
            value={mode ?? UNCHANGED}
            options={withCurrent(
              [{ label: "Unchanged", value: UNCHANGED }, ...(modes.data ?? []).map((m) => ({ label: m.label, value: m.id }))],
              mode,
            )}
            onValueChange={(v) => set("modeId", v)}
          />
        </>
      ) : null}
    </>
  );
}
