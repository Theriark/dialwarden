import { describe, expect, it } from "vitest";
import { bytes, edited, errorCode, text } from "../test/harness.js";
import { fixture } from "../test/kits.js";
import { xmlAdapter as xml, type XmlLocator } from "./index.js";
import { decodeAttribute, encodeAttribute } from "./xml.js";

function prop(property: string): XmlLocator {
  return { kind: "xml", property };
}

describe("XML property list", () => {
  const data = fixture("xml/serverconfig-like.xml");
  const source = text(data);
  const doc = xml.parse(data);

  it("reads property values, entities decoded", () => {
    expect(xml.lint(doc)).toEqual([]);
    expect(xml.get(doc, prop("ServerName"))).toBe("Ridge & Hollow");
    expect(xml.get(doc, prop("ServerDescription"))).toBe("Mostly peaceful <3");
    expect(xml.get(doc, prop("ServerPort"))).toBe("26900");
    expect(xml.get(doc, prop("Region"))).toBe("");
    expect(xml.get(doc, prop("ServerPassword"))).toBeUndefined();
  });

  it("replaces one attribute value and keeps attribute order", () => {
    const set = (name: string, value: string | number) =>
      edited(xml, data, (d) => xml.set(d, prop(name), value));
    expect(set("ServerName", "Ridge & Vale")).toBe(
      source.replace("Ridge &amp; Hollow", "Ridge &amp; Vale"),
    );
    expect(set("ServerPort", 27000)).toBe(source.replace("26900", "27000"));
    expect(set("ServerDescription", 'say "hi"')).toBe(
      source.replace("Mostly peaceful &lt;3", "say &quot;hi&quot;"),
    );
    expect(set("ServerPort", "it's")).toBe(
      source.replace("'26900'", "'it&apos;s'"),
    );
  });

  it("inserts after the last property with its indentation", () => {
    // The trailing spaces stay on the line of the property they follow.
    const out = edited(xml, data, (d) => xml.insert(d, prop("NewProp"), "x"));
    expect(out).toBe(
      source.replace(
        'value="8" />  \n',
        'value="8" />  \n\t<property name="NewProp" value="x" />\n',
      ),
    );
  });

  it("keeps a trailing comment with the property it follows", () => {
    const input = '<S>\n  <property name="A" value="1"/> <!-- a -->\n</S>\n';
    const out = edited(xml, input, (d) => xml.insert(d, prop("B"), 2));
    expect(out).toBe(
      '<S>\n  <property name="A" value="1"/> <!-- a -->\n' +
        '  <property name="B" value="2"/>\n</S>\n',
    );
    // Anything else after the property keeps the insert next to it.
    const shared = '<S>\n  <property name="A" value="1"/></S>\n';
    const next = edited(xml, shared, (d) => xml.insert(d, prop("B"), 2));
    expect(next).toBe(
      '<S>\n  <property name="A" value="1"/>\n' +
        '  <property name="B" value="2"/></S>\n',
    );
  });

  it("removes whole lines, also for an element with an end tag", () => {
    const visibility = edited(xml, data, (d) =>
      xml.remove(d, prop("ServerVisibility")),
    );
    expect(visibility).toBe(
      source.replace('\t<property name="ServerVisibility"  value="2"/>\n', ""),
    );
    const region = edited(xml, data, (d) => xml.remove(d, prop("Region")));
    const element = '\t<property name="Region" value="">\n\t</property>\n';
    expect(region).toBe(source.replace(element, ""));
    expect(xml.remove(doc, prop("Missing"))).toEqual([]);
  });

  it("refuses edits that do not fit", () => {
    expect(errorCode(() => xml.set(doc, prop("Missing"), 1))).toBe("not-found");
    expect(errorCode(() => xml.insert(doc, prop("ServerName"), 1))).toBe(
      "exists",
    );
    expect(errorCode(() => xml.set(doc, prop("ServerName"), null))).toBe(
      "invalid-value",
    );
    const wrong = { kind: "lua", path: [] } as unknown as XmlLocator;
    expect(errorCode(() => xml.get(doc, wrong))).toBe("invalid-locator");
  });
});

describe("XML edge cases", () => {
  it("adds a missing value attribute after the name", () => {
    const out = edited(xml, '<S><property name="A"/></S>', (d) =>
      xml.set(d, prop("A"), "1"),
    );
    expect(out).toBe('<S><property name="A" value="1"/></S>');
  });

  it("warns about duplicates, reads the last and removes all", () => {
    const input =
      '<S><property name="A" value="1"/><property name="A" value="2"/></S>';
    const doc = xml.parse(bytes(input));
    expect(xml.lint(doc)).toMatchObject([
      { code: "duplicate-key", severity: "warning" },
    ]);
    expect(xml.get(doc, prop("A"))).toBe("2");
    expect(errorCode(() => xml.set(doc, prop("A"), "3"))).toBe("ambiguous");
    const out = edited(xml, input, (d) => xml.remove(d, prop("A")));
    expect(out).toBe("<S></S>");
  });

  it("inserts the first property into the root element", () => {
    const lines = edited(xml, "<ServerSettings>\n</ServerSettings>\n", (d) =>
      xml.insert(d, prop("A"), "1"),
    );
    expect(lines).toBe(
      '<ServerSettings>\n  <property name="A" value="1"/>\n</ServerSettings>\n',
    );
    const inline = edited(xml, "<S></S>", (d) => xml.insert(d, prop("A"), 1));
    expect(inline).toBe('<S><property name="A" value="1"/></S>');
    const closed = xml.parse(bytes("<S/>"));
    expect(errorCode(() => xml.insert(closed, prop("A"), 1))).toBe("not-found");
  });

  it("reports malformed XML and refuses writes", () => {
    const doc = xml.parse(fixture("xml/malformed-unclosed-tag.xml"));
    expect(xml.lint(doc).some((i) => i.severity === "error")).toBe(true);
    expect(errorCode(() => xml.set(doc, prop("ServerName"), "x"))).toBe(
      "parse-error",
    );
    const codes = (input: string) =>
      xml.lint(xml.parse(bytes(input))).map((issue) => issue.code);
    expect(codes("<a><b></a>")).toEqual(["mismatched-tag"]);
    expect(codes("<a>")).toEqual(["unclosed-element"]);
    expect(codes("<!-- x")).toEqual(["unclosed-comment"]);
    expect(codes("<a x=1/>")).toEqual(["syntax"]);
    expect(codes('<a x="1" x="2"/>')).toEqual(["duplicate-attribute"]);
    expect(codes('<a x="<"/>')).toEqual(["syntax"]);
    expect(codes("<a")).toEqual(["unclosed-tag"]);
    expect(codes("< a/>")).toEqual(["syntax"]);
    expect(codes("<property value='1'/>")).toEqual(["property-without-name"]);
  });

  it("decodes and encodes attribute text", () => {
    expect(decodeAttribute("&#65;&#x42;&unknown;&#xFFFFFFF;")).toBe(
      "AB&unknown;&#xFFFFFFF;",
    );
    expect(decodeAttribute("a\tb\r\nc")).toBe("a b c");
    expect(encodeAttribute(`<&>"'\t\n\r`, '"')).toBe(
      "&lt;&amp;&gt;&quot;'&#9;&#10;&#13;",
    );
    const out = edited(xml, '<S><property name="A" value=""/></S>', (d) =>
      xml.set(d, prop("A"), "two\nlines"),
    );
    expect(xml.get(xml.parse(bytes(out)), prop("A"))).toBe("two\nlines");
  });

  it("keeps the BOM and CRLF and reads UTF-8", () => {
    const data = fixture("xml/crlf-bom.xml");
    const source = text(data);
    const doc = xml.parse(data);
    expect(xml.get(doc, prop("WorldName"))).toBe("Fjällhem");
    const out = edited(xml, data, (d) => xml.insert(d, prop("New"), "v"));
    expect(out).toBe(
      source.replace(
        'value="Fjällhem"/>',
        'value="Fjällhem"/>\r\n  <property name="New" value="v"/>',
      ),
    );
  });
});
