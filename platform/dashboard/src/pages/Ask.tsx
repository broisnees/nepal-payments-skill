import { AskChat } from "../components/AskChat.tsx";
import { useProject } from "../components/Shell.tsx";

export default function Ask() {
  const { project, env, base } = useProject();
  return (
    <div className="ask-page">
      <div className="page-head">
        <div>
          <h1>Ask</h1>
          <p>Questions about {project.name} ({env}) in plain words. Also on every page with Ctrl+I.</p>
        </div>
      </div>
      <AskChat projectId={project.id} projectName={project.name} env={env} base={base} />
    </div>
  );
}
