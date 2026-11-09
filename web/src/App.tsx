import { useState } from 'react';
import { getToken } from './api';
import { Layout } from './components/Layout';
import { useRoute } from './hooks';
import { DoctorPage } from './pages/DoctorPage';
import { ProjectsPage } from './pages/ProjectsPage';
import { SettingsPage } from './pages/SettingsPage';
import { WizardPage } from './pages/WizardPage';

export function App() {
  const route = useRoute();
  const [hasToken] = useState(() => getToken() !== '');

  if (!hasToken) {
    return (
      <Layout route={route}>
        <div className="alert alert--warning" role="alert">
          <div className="alert__content">
            <p className="alert__title">Access token missing</p>
            <p>
              Open the address printed by <code>recode ui</code> in your terminal. It contains the
              access token that protects your projects.
            </p>
          </div>
        </div>
      </Layout>
    );
  }

  return (
    <Layout route={route}>
      {route.name === 'projects' && <ProjectsPage />}
      {route.name === 'project' && <WizardPage key={route.project} project={route.project} />}
      {route.name === 'settings' && <SettingsPage />}
      {route.name === 'doctor' && <DoctorPage />}
    </Layout>
  );
}
