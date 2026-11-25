import "@fontsource-variable/archivo";
import "@fontsource-variable/jetbrains-mono";
import "../tokens.css";
import "../styles.css";
import "./admin.css";
import { render } from "solid-js/web";
import { Admin } from "./Admin";

render(() => <Admin />, document.getElementById("root")!);
