from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.chrome.service import Service
from webdriver_manager.chrome import ChromeDriverManager
import csv
import json
import time
import os
import requests
from datetime import datetime

SEARCH_URL = 'https://caleprocure.ca.gov/pages/Events-BS3/event-search.aspx'
OUTPUT_CSV = 'all_events_detailed.csv'
OUTPUT_JSON = 'all_events_detailed.json'
BASE_DOWNLOAD_DIR = os.path.abspath('downloads')


def scrape_event_page(driver, wait):
    # Wait until the URL is the real event page, not a loading placeholder
    def url_is_ready(driver):
        return 'page_loading' not in driver.current_url and '/event/' in driver.current_url
    
    try:
        wait.until(url_is_ready)
    except:
        print(f"  ✗ URL never resolved: {driver.current_url}")


    """Scrape data from event detail page"""
    event_data = {
        'event_url': driver.current_url,
        'event_id': '',
        'title': '',
        'description': '',
        'contact_name': '',
        'contact_email': '',
        'contact_phone': '',
        'department': '',
        'start_date': '',
        'end_date': '',
        'format': ''
    }

    parts = driver.current_url.split('/')
    if len(parts) >= 4:
        event_data['event_id'] = f"{parts[-2]}/{parts[-1]}"

    try:
        wait.until(
            EC.presence_of_element_located((By.CSS_SELECTOR, '[data-if-label="eventName"]'))
        )
        #time.sleep(3)
    except:
        pass

    try:
        title_elem = driver.find_element(By.CSS_SELECTOR, '[data-if-label="eventName"]')
        title = title_elem.text.strip()
        if title and title != '[Event Title]':
            event_data['title'] = title
    except:
        pass

    try:
        desc_elem = driver.find_element(By.CSS_SELECTOR, '[data-if-label="descriptiondetails"]')
        desc = desc_elem.text.strip()
        if desc and desc != '[Detail Description]':
            event_data['description'] = desc
    except:
        pass

    try:
        contact_elem = driver.find_element(By.CSS_SELECTOR, '[data-if-label="contactName"]')
        contact = contact_elem.text.strip()
        if contact and contact != '[Contact Name]':
            event_data['contact_name'] = contact
    except:
        pass

    try:
        email_elem = driver.find_element(By.CSS_SELECTOR, '[data-if-label="emailAnchor"]')
        email = email_elem.text.strip()
        if email and email != '[EmailAddress]':
            event_data['contact_email'] = email
    except:
        try:
            email_elem = driver.find_element(By.ID, 'RESP_INQ_DL0_WK_EMAILID')
            email = email_elem.text.strip()
            if email:
                event_data['contact_email'] = email
        except:
            pass

    try:
        phone_elem = driver.find_element(By.CSS_SELECTOR, '[data-if-label="phoneText"]')
        phone = phone_elem.text.strip()
        if phone and phone != '[Phone Number]':
            event_data['contact_phone'] = phone
    except:
        pass

    try:
        dept_elem = driver.find_element(By.CSS_SELECTOR, '[data-if-label="dept"]')
        dept = dept_elem.text.strip()
        if dept:
            event_data['department'] = dept
    except:
        pass

    try:
        start_elem = driver.find_element(By.CSS_SELECTOR, '[data-if-label="eventStartDate"]')
        start_date = start_elem.text.strip()
        if start_date:
            event_data['start_date'] = start_date
    except:
        pass

    try:
        end_elem = driver.find_element(By.CSS_SELECTOR, '[data-if-label="eventEndDate"]')
        end_date = end_elem.text.strip()
        if end_date:
            event_data['end_date'] = end_date
    except:
        pass

    try:
        format1_elem = driver.find_element(By.CSS_SELECTOR, '[data-if-label="format1"]')
        format2_elem = driver.find_element(By.CSS_SELECTOR, '[data-if-label="format2"]')
        format1 = format1_elem.text.strip()
        format2 = format2_elem.text.strip()
        if format1 or format2:
            event_data['format'] = f"{format1} / {format2}".strip(' /')
    except:
        pass

    return event_data


def download_attachments(driver, wait, event_id):
    """
    Clicks 'View Event Package', waits for attachments table,
    then for each attachment: opens modal → grabs URL → downloads via requests → closes modal.
    Files saved to downloads/<event_id>/
    """
    # Create a subfolder per event 
    safe_id = event_id.replace('/', '_')
    event_download_dir = os.path.join(BASE_DOWNLOAD_DIR, safe_id)
    os.makedirs(event_download_dir, exist_ok=True)

    print(f"  [attachments] Saving to: {event_download_dir}")

    #  Click "View Event Package"
    try:
        view_pkg_btn = wait.until(
            EC.element_to_be_clickable((By.CSS_SELECTOR, '[data-if-label="viewPackage"]'))
        )
        view_pkg_btn.click()
        print(f" Clicked 'View Event Package'")
    except Exception as e:
        print(f"  Could not click 'View Event Package': {e}")
        return

    # Wait for attachments table to load
    time.sleep(4)
    try:
        wait.until(
            EC.presence_of_element_located(
                (By.CSS_SELECTOR, '[data-if-label^="ViewAttachmentsTableRow"]')
            )
        )
        print(f"Attachments table loaded")
    except Exception as e:
        print(f"Attachments table did not load: {e}")
        return

    # count total downloads
    download_buttons = driver.find_elements(
        By.CSS_SELECTOR, 'button[data-if-label^="ViewAttachmentsView"]'
    )
    total = len(download_buttons)
    print(f" Found {total} attachment(s)")

    # loop — re-fetch each time to avoid stale refs 
    for i in range(total):
        try:
            # Re-fetch fresh every iteration
            download_buttons = driver.find_elements(
                By.CSS_SELECTOR, 'button[data-if-label^="ViewAttachmentsView"]'
            )
            btn = download_buttons[i]

            driver.execute_script("arguments[0].scrollIntoView(true);", btn)
            time.sleep(0.5)
            btn.click()
            print(f"  [attachments] Clicked button #{i + 1}/{total}")

            # Wait for modal
            wait.until(EC.visibility_of_element_located((By.ID, 'attachmentBox')))
            time.sleep(3)

            # Grab the PDF URL from the download link
            download_link = wait.until(
                EC.element_to_be_clickable((By.ID, 'downloadButton'))
            )
            pdf_url = download_link.get_attribute('href')

            if not pdf_url:
                print(f"  [attachments] ✗ No URL found for attachment #{i + 1}, skipping")
            else:
                # Pass session cookies so the server authorises the download
                cookies = {c['name']: c['value'] for c in driver.get_cookies()}

                # Build filename from URL, fallback to index
                filename = pdf_url.split('/')[-1].split('?')[0] or f'attachment_{i + 1}.pdf'
                # Ensure .pdf extension if missing
                if '.' not in filename:
                    filename += '.pdf'
                filepath = os.path.join(event_download_dir, filename)

                response = requests.get(pdf_url, cookies=cookies, stream=True)
                response.raise_for_status()
                with open(filepath, 'wb') as f:
                    for chunk in response.iter_content(chunk_size=8192):
                        f.write(chunk)
                print(f"  [attachments] ✓ Saved: {filename}")

            # Close the modal
            close_btn = driver.find_element(
                By.CSS_SELECTOR, '#attachmentWrapperModal .btn-outline-primary'
            )
            close_btn.click()
            time.sleep(3)

        except Exception as e:
            print(f"  [attachments] ✗ Error on attachment #{i + 1}: {e}")
            # Try to close modal if stuck open
            try:
                driver.find_element(
                    By.CSS_SELECTOR, '#attachmentWrapperModal .btn-outline-primary'
                ).click()
            except:
                pass
            time.sleep(3)


def main():
    # make folder for attachment download 
    os.makedirs(BASE_DOWNLOAD_DIR, exist_ok=True)

    # using selenium ; initial options were beautifulsoup and requests-html
    # possible additions: using scrapy to scale and do asynchronous 
    options = webdriver.ChromeOptions()

    # played with the headless option but was crashing 
    #options.add_argument('--headless') 
    #options.add_argument('--no-sandbox')
    #options.add_argument('--disable-dev-shm-usage')

    options.add_argument('--window-size=1920,1080')

    service = Service(ChromeDriverManager().install())
    driver = webdriver.Chrome(service=service, options=options)
    wait = WebDriverWait(driver, 20) # set up watiing timeout for event wait 

    all_events = []


    try:
        # loads search page 
        print("\n1. Loading search page...")
        driver.get(SEARCH_URL)
        time.sleep(10)

        # use css to find table and get all rows 
        print("\n2. Counting events...")
        all_rows = driver.find_elements(By.CSS_SELECTOR, '[data-if-label^="tblBodyTr"]')
        visible_rows = [
            row for row in all_rows
            if 'if-hide' not in (row.get_attribute('class') or '') and row.is_displayed()
        ]
        total_events = len(visible_rows)
        print(f"   Found {total_events} events")

        # scraping 
        print("\n3. Scraping events...")
        print("=" * 80)

        for i in range(total_events):
            print(f"\nEvent {i + 1}/{total_events}:")

            try:
                # Reload search page fresh each time we go back 
                # otherwise cannot click on link
                driver.get(SEARCH_URL)
                time.sleep(10)

                all_rows = driver.find_elements(By.CSS_SELECTOR, '[data-if-label^="tblBodyTr"]')
                visible_rows = [
                    row for row in all_rows
                    if 'if-hide' not in (row.get_attribute('class') or '') and row.is_displayed()
                ]

                # if refreshing changes # of events somehoe  
                if i >= len(visible_rows):
                    continue

                row = visible_rows[i]

                # find the cell to click 

                original_window = driver.current_window_handle
                original_windows = driver.window_handles

                print(f"  Clicking...")
                event_id_cell = row.find_element(By.CSS_SELECTOR, '[data-if-label="tdEventId"]')
                event_id_cell.click()
                time.sleep(2) # wait for tab to load 

                new_windows = driver.window_handles

                if len(new_windows) > len(original_windows):
                    # find new tab to switch into 
                    new_window = [w for w in new_windows if w not in original_windows][0]
                    driver.switch_to.window(new_window)

                    print(f"  Scraping event page...")
                    event_data = scrape_event_page(driver, wait)

                    if event_data['title']:
                        print(f"Title: {event_data['title'][:60]}")

                    # ── Download attachments for this event ──────────────
                    download_attachments(driver, wait, event_data['event_id'])

                    all_events.append(event_data)

                    driver.close()
                    driver.switch_to.window(original_window)

                # Save progress every 10 events
                if len(all_events) % 10 == 0:
                    with open(OUTPUT_JSON, 'w', encoding='utf-8') as f:
                        json.dump({
                            'scrape_date': datetime.now().isoformat(),
                            'total_events': len(all_events),
                            'events': all_events
                        }, f, indent=2, ensure_ascii=False)
                    print(f"Progress saved ({len(all_events)} events)")

            except KeyboardInterrupt:
                print("\n\nInterrupted by user")
                break
            except Exception as e:
                print(f"Error: {e}")
                try:
                    driver.switch_to.window(original_window)
                except:
                    pass
                continue

        # final save 
        print("\n" + "=" * 80)
        print(f"Scraping complete! Collected {len(all_events)} events")

        if all_events:
            print(f"\nSaving to {OUTPUT_CSV}...")
            fieldnames = [
                'event_id', 'event_url', 'title', 'description',
                'department', 'format', 'start_date', 'end_date',
                'contact_name', 'contact_email', 'contact_phone'
            ]
            with open(OUTPUT_CSV, 'w', newline='', encoding='utf-8') as f:
                writer = csv.DictWriter(f, fieldnames=fieldnames)
                writer.writeheader()
                writer.writerows(all_events)
            print(f"✓ Saved to {OUTPUT_CSV}")

            with open(OUTPUT_JSON, 'w', encoding='utf-8') as f:
                json.dump({
                    'scrape_date': datetime.now().isoformat(),
                    'total_events': len(all_events),
                    'events': all_events
                }, f, indent=2, ensure_ascii=False)
            print(f"✓ Saved to {OUTPUT_JSON}")

        print("\nAll done!")

    except Exception as e:
        print(f"\nError: {e}")
        import traceback
        traceback.print_exc()

    finally:
        driver.quit()
        print("\nBrowser closed.")


if __name__ == '__main__':
    main()