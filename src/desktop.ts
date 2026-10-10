import { Desktop, Selector } from "@mediar-ai/terminator";
import * as Terminator from "@mediar-ai/terminator";
import { pressShortcut } from "./utils/keyboard";

export const desktop = new Desktop();

export const getRoot = () => {
  const rootUiElement = desktop.root();
  console.log(rootUiElement);
  return rootUiElement;
};

export const getAllRunningApplicatoins = async () => {
  const applications = desktop.applications();

  console.log(applications);
  return applications;
};

const getApplication = async (name: string) => {
  const application = desktop.application(name);
  application.activateWindow();
  const tree = desktop.getWindowTreeResult(name, undefined, {
    formatOutput: true,
    treeOutputFormat: Terminator.TreeOutputFormat.CompactYaml,
    propertyMode: Terminator.PropertyLoadingMode.Complete,
  });
  console.log(tree.elementCount);

  const clicked = desktop.clickByIndex(111);

  await pressShortcut("Win+I");

  return application.attributes();
};
