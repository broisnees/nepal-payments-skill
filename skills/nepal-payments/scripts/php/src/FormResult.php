<?php

declare(strict_types=1);

namespace NepalPayments;

/** Render an auto-submitting HTML form that POSTs `$fields` to `$action` (see {@see Html::renderAutoSubmitForm()}). */
final class FormResult implements InitiateResult
{
    public readonly string $kind;

    /**
     * @param array<string, string> $fields
     * @param string|null $enctype null = application/x-www-form-urlencoded. NPS requires "multipart/form-data".
     * @param string|null $providerRef Persist when set (e.g. NPS ProcessId).
     */
    public function __construct(
        public readonly string $action,
        public readonly array $fields,
        public readonly string $method = 'POST',
        public readonly ?string $enctype = null,
        public readonly ?string $providerRef = null,
    ) {
        $this->kind = 'form';
    }

    public function render(): string
    {
        return Html::renderAutoSubmitForm($this);
    }
}
