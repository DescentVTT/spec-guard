export function PrimaryButton(props: { label: string }): string {
  return '<button class="primary">' + props.label + '</button>';
}

export const PrimaryButtonTestId = 'primary-button';
