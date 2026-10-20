import { describe, expect, it } from "vitest";
import { distinctiveTokens, hubEvidence, nameEvidence } from "../customer-match.js";

describe("customer name evidence", () => {
  it.each([
    ["Northwind", "NORTHWIND CORPORATION", "name"],
    ["Nortwind", "NORTHWIND CORPORATION", "name"],
    ["Tailspin", "Tailspin (Wingtip Toys)", "name"],
    ["WingtipToys", "Tailspin (Wingtip Toys)", "name"],
    ["Alpine Ski", "ALPINE SKI HOUSE AND COMPANY", "name"],
    ["ASH", "ALPINE SKI HOUSE AND COMPANY", "acronym"],
    ["CGB", "City General Brands (Partners)", "acronym"],
    ["WoodgroveBank", "Woodgrovebank Group", "name"],
    ["Woodgrove Bank", "Woodgrovebank Group", "name"],
    ["Childrens Denver", "CHILDREN'S HOSPITAL DENVER", "name"],
    ["Adatum Labs", "ADATUM LABS AND COMPANY", "name"],
    ["Litw", "LITWARE CORPORATION", "name"],
  ])("%s matches %s by %s", (query, name, evidence) => {
    expect(nameEvidence(query, name)).toBe(evidence);
  });

  it.each([
    ["Hospital", "CHILDRENS HOSPITAL DENVER"],
    ["Corporation", "LITWARE SYSTEMS CORPORATION"],
    ["Proseware", "NORTHWIND CORPORATION"],
    ["Northwind Proseware", "NORTHWIND CORPORATION"],
    ["Fourth Coffee", "Q1 Labs Inc"],
    ["Lit", "LITWARE SYSTEMS CORPORATION"],
    ["Q2", "Q1 Labs Inc"],
    ["LS", "LITWARE SYSTEMS CORPORATION"],
  ])("%s does not match %s", (query, name) => {
    expect(nameEvidence(query, name)).toBeNull();
  });

  it("strips legal and industry boilerplate from queries", () => {
    expect(distinctiveTokens("The Acme Corp, Inc.")).toEqual(["acme"]);
    expect(distinctiveTokens("Hospital Group")).toEqual([]);
  });

  it("prefers a full name match across a hub's names", () => {
    expect(hubEvidence("ASH", ["ALPINE SKI HOUSE AND COMPANY", "ASH"])).toBe("name");
    expect(hubEvidence("ASH", ["ALPINE SKI HOUSE AND COMPANY"])).toBe("acronym");
    expect(hubEvidence("ASH", [])).toBeNull();
  });
});
