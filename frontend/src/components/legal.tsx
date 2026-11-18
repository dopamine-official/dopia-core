"use client";

import { useEffect, useState, type ReactNode } from "react";
import { regionCode, type Locale } from "@/i18n";

// Legal documents are copied from dopia-spec POLICY/LEGAL into public/legal/<region>/<locale>/,
// the common text and the region appendix merged into one file. A locale without its own
// translation yet shows the Korean source.
const SOURCE_LOCALE: Locale = "ko-KR";

async function load(doc: string, locale: Locale) {
  for (const candidate of [locale, SOURCE_LOCALE]) {
    const response = await fetch(`/legal/${regionCode}/${candidate}/${doc}.md`);
    if (response.ok) return response.text();
  }
  throw new Error(`Missing legal document: ${doc}`);
}

/** One legal document, drawn from the small Markdown subset the policy files use. */
export function LegalDocument({
  doc,
  locale,
  fallback,
}: {
  doc: string;
  locale: Locale;
  fallback: ReactNode;
}) {
  const [source, setSource] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    load(doc, locale).then(
      (value) => live && setSource(value),
      () => live && setFailed(true),
    );
    return () => {
      live = false;
    };
  }, [doc, locale]);
  if (failed || source === null) return <>{failed ? fallback : null}</>;
  return <div className="legal_document">{blocks(source)}</div>;
}

function cells(row: string) {
  return row
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((cell) => cell.trim());
}

function lines(value: string) {
  return value.split("<br>").map((part, index) => (
    <span key={index}>
      {index > 0 && <br />}
      {part}
    </span>
  ));
}

function blocks(source: string) {
  const rows = source.split("\n");
  const out: ReactNode[] = [];
  let index = 0;
  while (index < rows.length) {
    const row = rows[index];
    const key = out.length;
    const heading = /^(#{1,4}) (.*)$/.exec(row);
    if (!row.trim()) {
      index += 1;
    } else if (heading) {
      const level = Math.min(heading[1].length + 1, 5);
      const Tag = `h${level}` as "h2";
      out.push(<Tag key={key}>{heading[2]}</Tag>);
      index += 1;
    } else if (row.startsWith("|")) {
      const table: string[] = [];
      while (index < rows.length && rows[index].startsWith("|"))
        table.push(rows[index++]);
      const [head, , ...body] = table;
      out.push(
        <table key={key}>
          <thead>
            <tr>
              {cells(head).map((cell, i) => (
                <th key={i}>{lines(cell)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {body.map((line, r) => (
              <tr key={r}>
                {cells(line).map((cell, i) => (
                  <td key={i}>{lines(cell)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>,
      );
    } else if (/^\d+\. /.test(row)) {
      const items: { text: string; sub: string[] }[] = [];
      while (index < rows.length && /^(\d+\. |\s+- )/.test(rows[index])) {
        const line = rows[index++];
        if (/^\d+\. /.test(line))
          items.push({ text: line.replace(/^\d+\. /, ""), sub: [] });
        else items[items.length - 1]?.sub.push(line.replace(/^\s+- /, ""));
      }
      out.push(
        <ol key={key}>
          {items.map((item, i) => (
            <li key={i}>
              {item.text}
              {item.sub.length > 0 && (
                <ul>
                  {item.sub.map((sub, s) => (
                    <li key={s}>{sub}</li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ol>,
      );
    } else if (/^\s*- /.test(row)) {
      const items: string[] = [];
      while (index < rows.length && /^\s*- /.test(rows[index]))
        items.push(rows[index++].replace(/^\s*- /, ""));
      out.push(
        <ul key={key}>
          {items.map((item, i) => (
            <li key={i}>{item}</li>
          ))}
        </ul>,
      );
    } else {
      out.push(<p key={key}>{row}</p>);
      index += 1;
    }
  }
  return out;
}
