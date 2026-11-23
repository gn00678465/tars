/**
 * The page's own A2UI catalog: one component, AccountSelect, the ledger form's account field as
 * shadcn's Combobox (Base UI): typing Chinese or English narrows the accounts. Part of the A2UI
 * chunk: imported only by A2uiCard, so Base UI stays off the first load. Its schema is built
 * from the basic catalog's own (zod 3) schemas, so nothing here imports zod: the page's zod is
 * 4, and the two do not mix (research/a2ui_proto_result.md).
 */
import { createComponentImplementation, type ReactCatalogComponent } from "@a2ui/react";
import { Catalog, ChoicePickerApi, TextFieldApi } from "@a2ui/web_core/v1_0";
import { useId, useMemo } from "react";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "@/components/ui/combobox";

/** The catalog's id: a name, never fetched. A2uiCard sets it on each AccountSelect. */
export const TARS_CATALOG_ID = "urn:tars:a2ui:catalog:v1";

/** The name a form writes; packages/protocol's UI_COMPONENTS lists it too. */
export const ACCOUNT_SELECT = "AccountSelect";

/**
 * label and value (bound with @path) as a TextField has them, options as a ChoicePicker has
 * them ({label, value}). Strict, like the basic catalog's: no other key.
 */
const schema = TextFieldApi.schema
  .pick({ label: true, value: true })
  .required({ value: true })
  .extend({ options: ChoicePickerApi.schema.shape.options });

interface Option {
  label: string;
  value: string;
}

const AccountSelect = createComponentImplementation(
  { name: ACCOUNT_SELECT, schema },
  ({ props }) => {
    const id = useId();
    const options = useMemo<Option[]>(
      () =>
        props.options.map((o) => ({
          label: typeof o.label === "string" ? o.label : o.value,
          value: o.value,
        })),
      [props.options],
    );
    // Nothing picked, or a value not offered: the field is empty and no account is sent. The
    // label is what is shown and filtered on; the English name in value is what is written.
    const picked = options.find((o) => o.value === props.value) ?? null;
    return (
      <div className="flex w-full flex-col gap-1">
        <label htmlFor={id} className="text-sm font-bold">
          {props.label}
        </label>
        <Combobox
          items={options}
          value={picked}
          onValueChange={(o: Option | null) => props.setValue(o?.value ?? "")}
          isItemEqualToValue={(a: Option, b: Option) => a.value === b.value}
          autoHighlight
        >
          {/* The basic catalog's fields' height and fill, so the form reads as one. shadcn's
              input is 16px below md: iOS does not zoom the page on focus. */}
          <ComboboxInput
            id={id}
            placeholder="請選擇（可打字過濾）"
            className="h-10 w-full dark:bg-(--a2ui-color-input)"
          />
          <ComboboxContent>
            <ComboboxEmpty>沒有符合的帳戶</ComboboxEmpty>
            <ComboboxList>
              {(o: Option) => (
                <ComboboxItem key={o.value} value={o}>
                  {o.label}
                </ComboboxItem>
              )}
            </ComboboxList>
          </ComboboxContent>
        </Combobox>
      </div>
    );
  },
);

export const tarsCatalog = new Catalog<ReactCatalogComponent>(TARS_CATALOG_ID, "1.0", [
  AccountSelect,
]);
