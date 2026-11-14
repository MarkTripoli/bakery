import type { Meta, StoryObj } from "@storybook/react-vite";
import { useEffect } from "react";
import { SectionNavigation } from "@bakery/ui";

const repositories = [
  { id: "overview", label: "Overview", href: "#overview" },
  {
    id: "repositories",
    label: "Repositories · selected",
    href: "#repositories",
  },
];

const meta = {
  title: "Bakery/Organisms/SectionNavigation",
  parameters: {
    catalogId: "ui.sectionNavigation",
    requiredCases: ["contract"],
  },
} satisfies Meta;
export default meta;

function ContractStory() {
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      document.querySelector<HTMLDetailsElement>(
        ".section-navigation-paper-contract details.bakery-section-navigation__mobile",
      )?.setAttribute("open", "");
      document.querySelector<HTMLAnchorElement>(
        '.section-navigation-paper-contract a[href="#integrations"]',
      )?.focus({ focusVisible: true });
    });
    return () => cancelAnimationFrame(frame);
  }, []);

  return (
    <div className="section-navigation-paper-contract">
      <div className="section-navigation-paper-contract__intro">
        <div className="section-navigation-paper-contract__kicker">
          ui.sectionNavigation / contract / light / sheet / coarse / token
          49fea8f7
        </div>
        <h1>SectionNavigation</h1>
        <p>
          Every declared variant × state is a separately visible specimen below.
        </p>
      </div>
      <div className="section-navigation-paper-contract__sections">
        <section>
          <strong>Sidebar · default / selected</strong>
          <div className="section-navigation-paper-contract__sidebar">
            <strong>GitHub</strong>
            <SectionNavigation
              currentPath="#repositories"
              items={repositories}
              label="GitHub"
              narrowMode="index"
              state="selected"
              variant="sidebar"
            />
          </div>
        </section>
        <section>
          <strong>Sidebar · default</strong>
          <SectionNavigation
            currentPath="#overview"
            items={repositories}
            label="Default section navigation"
            narrowMode="index"
            state="default"
            variant="sidebar"
          />
        </section>
        <section>
          <strong>Index · returning</strong>
          <SectionNavigation
            currentPath="#integrations"
            items={[{
              id: "return",
              label: "Returning to Integrations",
              href: "#integrations",
            }]}
            label="Returning index"
            narrowMode="index"
            state="returning"
            variant="index"
          />
        </section>
        <section>
          <strong>Sidebar · grouped</strong>
          <SectionNavigation
            currentPath="#repositories"
            groups={[
              {
                id: "account",
                heading: "Your account",
                items: [repositories[0]],
              },
              {
                id: "organization",
                heading: "Organization",
                items: [repositories[1]],
              },
            ]}
            label="Grouped section navigation"
            narrowMode="index"
            state="selected"
            variant="sidebar"
          />
        </section>
        <section>
          <strong>Menu · default / selected</strong>
          <SectionNavigation
            currentPath="#repositories"
            items={[repositories[1]]}
            label="Section index"
            narrowMode="menu"
            state="selected"
            variant="menu"
          />
        </section>
      </div>
    </div>
  );
}

const wideRepositories = [
  { id: "overview", label: "Overview", href: "#overview" },
  { id: "repositories", label: "Repositories", href: "#repositories" },
  { id: "integrations", label: "Integrations", href: "#integrations" },
];

function WideStory() {
  return (
    <SectionNavigation
      currentPath="#repositories"
      items={wideRepositories}
      label="repository sections"
      narrowMode="index"
      state="default"
      variant="sidebar"
    />
  );
}

export const Contract: StoryObj = {
  render: () =>
    globalThis.innerWidth >= 1440 ? <WideStory /> : <ContractStory />,
};
