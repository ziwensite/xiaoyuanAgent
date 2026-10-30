import "obsidian";

declare module "obsidian" {
  interface App {
    setting: {
      open(): void;
      openTabById(id: string): void;
    };
    commands: {
      executeCommandById(id: string): void;
      listCommands(): { id: string; name: string }[];
    };
  }

  interface MenuItem {
    setSubmenu(): Menu;
  }

  interface View {
    quote?(text: string): void;
  }
}
